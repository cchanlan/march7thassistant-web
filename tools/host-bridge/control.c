/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 cchanlan
 * This file is part of March7thAssistant Web and is licensed under GPL-3.0-only.
 */
#define _GNU_SOURCE
#include "bridge.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define CONTROL_ARGS 64
#define REQUEST_MAX 4096
#define CONTROL_TIMEOUT_MAX 30000

/* The main bridge isolates each worker in its own process group and kills that
 * group after EVERY result, not only on timeout. Children must not setsid() or
 * change groups: the main deadline must cover exec, NSS and inherited pipes. */
struct ctl_request {
    const char *command;
    const char *property;
    const char *units[CONTROL_ARGS];
    size_t unit_count;
    unsigned flags;
    int kind;
    int timeout;
    int user;
    uid_t uid;
};

struct pm_request {
    const char *home;
    const char *start_time;
    const char *socket_inode;
    pid_t pid;
    uid_t uid;
    int timeout;
    int kind;
    unsigned char *wire;
    size_t wire_len;
    char id[33];
};

enum {
    OPT_USER = 1u << 0, OPT_SYSTEM = 1u << 1,
    OPT_PAGER = 1u << 2, OPT_PASSWORD = 1u << 3,
    OPT_ALL = 1u << 4, OPT_LEGEND = 1u << 5,
    OPT_PLAIN = 1u << 6, OPT_TYPE = 1u << 7,
    OPT_PROPERTY = 1u << 8
};

static int object_keys(struct json_object *obj, const char *const *allowed)
{
    if (!obj || !json_object_is_type(obj, json_type_object)) return 0;
    json_object_object_foreach(obj, key, value) {
        size_t i;
        (void)value;
        for (i = 0; allowed[i] && strcmp(key, allowed[i]); ++i) {}
        if (!allowed[i]) return 0;
    }
    return 1;
}

static struct json_object *member(struct json_object *obj, const char *key)
{
    struct json_object *value = NULL;
    if (obj) json_object_object_get_ex(obj, key, &value);
    return value;
}

static const char *text(struct json_object *value)
{
    const char *s;
    if (!value || !json_object_is_type(value, json_type_string)) return NULL;
    s = json_object_get_string(value);
    if (!s || strlen(s) != (size_t)json_object_get_string_len(value)) return NULL;
    return s;
}

static int bounded_integer(struct json_object *value, int64_t max, int64_t *out)
{
    int64_t n;
    if (!value || !json_object_is_type(value, json_type_int)) return 0;
    n = json_object_get_int64(value);
    if (n < 0 || n > max) return 0;
    *out = n;
    return 1;
}

static int timeout_value(struct json_object *params, int *out)
{
    struct json_object *value;
    int64_t n;
    if (!json_object_object_get_ex(params, "timeout", &value)) {
        *out = 3500;
        return 1;
    }
    if (!bounded_integer(value, CONTROL_TIMEOUT_MAX, &n) || !n) return 0;
    *out = (int)n;
    return 1;
}

static int decimal_string(const char *s, size_t maximum)
{
    size_t i, len;
    if (!s || !(len = strlen(s)) || len > maximum) return 0;
    for (i = 0; i < len; ++i) if (s[i] < '0' || s[i] > '9') return 0;
    return 1;
}

/* This deliberately matches processes.mjs validUnit, not systemd's much wider
 * unit/path/pattern grammar. No absolute paths, globbing, escapes or options. */
static int service_unit(const char *s)
{
    size_t i, len;
    if (!s || (len = strlen(s)) < 9 || len > 199) return 0;
    if (strcmp(s + len - 8, ".service")) return 0;
    if (!((s[0] >= 'A' && s[0] <= 'Z') ||
          (s[0] >= 'a' && s[0] <= 'z') || (s[0] >= '0' && s[0] <= '9'))) return 0;
    for (i = 1; i < len - 8; ++i) {
        char c = s[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '.' ||
              c == '@' || c == ':' || c == '-')) return 0;
    }
    return 1;
}

static int allowed_properties(const char *s)
{
    static const char *const names[] = {
        "Id", "LoadState", "ActiveState", "SubState", "Type", "MainPID",
        "ControlPID", "InvocationID", "WorkingDirectory", "ExecStart",
        "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost",
        "FragmentPath", "DropInPaths", "CanStart", "CanStop",
        "RefuseManualStart", "RefuseManualStop", "NeedDaemonReload",
        "TriggeredBy", "ConsistsOf", "BoundBy", "PropagatesStopTo",
        "Environment", "EnvironmentFiles", "KillMode", "OnSuccess", "OnFailure", NULL
    };
    uint64_t seen = 0;
    if (!s || !*s || strlen(s) > 1024) return 0;
    while (*s) {
        const char *end = strchr(s, ',');
        size_t len = end ? (size_t)(end - s) : strlen(s), i;
        if (!len) return 0;
        for (i = 0; names[i]; ++i)
            if (strlen(names[i]) == len && !memcmp(names[i], s, len)) break;
        if (!names[i] || (seen & (UINT64_C(1) << i))) return 0;
        seen |= UINT64_C(1) << i;
        if (!end) return 1;
        s = end + 1;
    }
    return 0;
}

static int parse_systemctl(struct json_object *params, struct ctl_request *r)
{
    static const char *const keys[] = { "args", "timeout", "uid", NULL };
    struct json_object *args, *uid_value = NULL;
    size_t i, count;
    int after_separator = 0;
    int64_t uid_number;
    memset(r, 0, sizeof(*r));
    if (!object_keys(params, keys) || !timeout_value(params, &r->timeout)) return -1;
    args = member(params, "args");
    if (!args || !json_object_is_type(args, json_type_array)) return -1;
    count = json_object_array_length(args);
    if (!count || count > CONTROL_ARGS) return -1;
    for (i = 0; i < count; ++i) {
        const char *s = text(json_object_array_get_idx(args, i));
        unsigned flag = 0;
        if (!s || !*s || strlen(s) > 1100) return -1;
        if (after_separator) {
            if (!service_unit(s) || r->unit_count >= CONTROL_ARGS) return -1;
            r->units[r->unit_count++] = s;
            continue;
        }
        if (!strcmp(s, "--")) {
            if (!r->command) return -1;
            after_separator = 1;
            continue;
        }
        if (!strcmp(s, "show") || !strcmp(s, "list-unit-files") ||
            !strcmp(s, "start") || !strcmp(s, "stop")) {
            if (r->command) return -1;
            r->command = s;
            continue;
        }
        if (!strcmp(s, "--user")) flag = OPT_USER;
        else if (!strcmp(s, "--system")) flag = OPT_SYSTEM;
        else if (!strcmp(s, "--no-pager")) flag = OPT_PAGER;
        else if (!strcmp(s, "--no-ask-password")) flag = OPT_PASSWORD;
        else if (!strcmp(s, "--all")) flag = OPT_ALL;
        else if (!strcmp(s, "--no-legend")) flag = OPT_LEGEND;
        else if (!strcmp(s, "--plain")) flag = OPT_PLAIN;
        else if (!strcmp(s, "--type=service")) flag = OPT_TYPE;
        else if (!strncmp(s, "--property=", 11)) {
            flag = OPT_PROPERTY;
            if (!allowed_properties(s + 11)) return -1;
            r->property = s;
        } else return -1;
        if (r->flags & flag) return -1;
        r->flags |= flag;
    }
    if (!r->command || ((r->flags & OPT_USER) && (r->flags & OPT_SYSTEM))) return -1;
    r->user = !!(r->flags & OPT_USER);
    if (!json_object_object_get_ex(params, "uid", &uid_value)) return -1;
    if (r->user) {
        if (!bounded_integer(uid_value, (int64_t)UINT32_MAX - 1, &uid_number)) return -1;
        r->uid = (uid_t)uid_number;
        if ((int64_t)r->uid != uid_number) return -1;
    } else if (uid_value && !json_object_is_type(uid_value, json_type_null)) return -1;
    if (!strcmp(r->command, "list-unit-files")) {
        if (r->unit_count || after_separator || !(r->flags & OPT_TYPE) ||
            (r->flags & OPT_PROPERTY)) return -1;
        r->kind = 0;
    } else if (!strcmp(r->command, "show")) {
        if (!r->unit_count || !after_separator || !(r->flags & OPT_PROPERTY) ||
            (r->flags & (OPT_TYPE | OPT_LEGEND | OPT_PLAIN))) return -1;
        r->kind = 0;
    } else {
        if (r->unit_count != 1 || !after_separator ||
            (r->flags & (OPT_ALL | OPT_TYPE | OPT_LEGEND | OPT_PLAIN | OPT_PROPERTY))) return -1;
        r->kind = !strcmp(r->command, "start") ? 2 : 1;
    }
    return r->kind;
}

static uint32_t be32(const unsigned char *s)
{
    return ((uint32_t)s[0] << 24) | ((uint32_t)s[1] << 16) |
           ((uint32_t)s[2] << 8) | (uint32_t)s[3];
}

static void put_be32(unsigned char *s, uint32_t n)
{
    s[0] = (unsigned char)(n >> 24); s[1] = (unsigned char)(n >> 16);
    s[2] = (unsigned char)(n >> 8); s[3] = (unsigned char)n;
}

/* 0 = incomplete, 1 = precisely one complete AMP v1/two-part frame. */
static int amp_frame(const unsigned char *buf, size_t len, size_t limit,
                     size_t offsets[2], size_t sizes[2])
{
    size_t cursor = 1, i;
    if (!len) return 0;
    if (len > limit || buf[0] != 0x12) return -1;
    for (i = 0; i < 2; ++i) {
        if (cursor > limit || limit - cursor < 4) return -1;
        if (len - cursor < 4) return 0;
        sizes[i] = be32(buf + cursor);
        cursor += 4;
        if (sizes[i] < 2 || sizes[i] > limit - cursor) return -1;
        offsets[i] = cursor;
        if (len - cursor < sizes[i]) return 0;
        cursor += sizes[i];
    }
    return cursor == len ? 1 : -1;
}

static struct json_object *parse_json(const unsigned char *buf, size_t len)
{
    return parse_json_strict(buf, len, 64);
}

static int parse_pm2(struct json_object *params, struct pm_request *r)
{
    static const char *const keys[] = { "daemon", "buffer", "timeout", NULL };
    static const char *const daemon_keys[] = {
        "state", "home", "pid", "startTime", "socketInode", "uid", NULL
    };
    static const char *const call_keys[] = { "type", "method", "args", NULL };
    struct json_object *daemon, *body = NULL, *args, *arg, *canonical = NULL, *array;
    const char *encoded, *method, *state, *json;
    unsigned char *decoded = NULL;
    size_t len = 0, offsets[2], sizes[2], i, json_len;
    int64_t number;
    int result = -1;
    memset(r, 0, sizeof(*r));
    if (!object_keys(params, keys) || !timeout_value(params, &r->timeout)) goto done;
    daemon = member(params, "daemon");
    if (!object_keys(daemon, daemon_keys)) goto done;
    state = text(member(daemon, "state"));
    if (!state || strcmp(state, "running")) goto done;
    r->home = text(member(daemon, "home"));
    if (!r->home || !valid_path(r->home) || strlen(r->home) >= PATH_MAX) goto done;
    if (!bounded_integer(member(daemon, "pid"), INT_MAX, &number) || !number) goto done;
    r->pid = (pid_t)number;
    if (!bounded_integer(member(daemon, "uid"), (int64_t)UINT32_MAX - 1, &number)) goto done;
    r->uid = (uid_t)number;
    if ((int64_t)r->uid != number) goto done;
    if (!json_object_object_get_ex(daemon, "startTime", &arg)) goto done;
    r->start_time = text(arg);
    if (!decimal_string(r->start_time, 31)) goto done;
    if (!json_object_object_get_ex(daemon, "socketInode", &arg)) goto done;
    r->socket_inode = text(arg);
    if (!decimal_string(r->socket_inode, 20)) goto done;
    encoded = text(member(params, "buffer"));
    if (!encoded || strlen(encoded) > (REQUEST_MAX + 2u) / 3u * 4u ||
        b64_decode(encoded, &decoded, &len, REQUEST_MAX) != 0) goto done;
    if (amp_frame(decoded, len, REQUEST_MAX, offsets, sizes) != 1 ||
        decoded[offsets[0]] != 'j' || decoded[offsets[0] + 1] != ':' ||
        sizes[1] != 34 || decoded[offsets[1]] != 's' || decoded[offsets[1] + 1] != ':') goto done;
    for (i = 0; i < 32; ++i) {
        char c = (char)decoded[offsets[1] + 2 + i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) goto done;
        r->id[i] = c;
    }
    /* json-c stores object keys as C strings. Reject escaped NULs before
     * parsing so an unknown key such as "method\\u0000extra" cannot collapse
     * onto an allowed key. No valid call-schema value needs an escaped NUL. */
    if (memmem(decoded + offsets[0] + 2, sizes[0] - 2, "\\u0000", 6)) goto done;
    body = parse_json(decoded + offsets[0] + 2, sizes[0] - 2);
    if (!object_keys(body, call_keys) || json_object_object_length(body) != 3) goto done;
    state = text(member(body, "type"));
    method = text(member(body, "method"));
    args = member(body, "args");
    if (!state || strcmp(state, "call") || !method || !args ||
        !json_object_is_type(args, json_type_array) || json_object_array_length(args) != 1) goto done;
    arg = json_object_array_get_idx(args, 0);
    if (!strcmp(method, "getMonitorData")) {
        if (!arg || !json_object_is_type(arg, json_type_object) || json_object_object_length(arg)) goto done;
        r->kind = 0;
    } else if (!strcmp(method, "stopProcessId") || !strcmp(method, "startProcessId")) {
        if (!bounded_integer(arg, INT_MAX, &number)) goto done;
        r->kind = !strcmp(method, "startProcessId") ? 2 : 1;
    } else goto done;

    /* Do not forward raw caller JSON: re-encode the validated closed schema.
     * This also prevents C/JS parser disagreement from changing the RPC call. */
    canonical = json_object_new_object();
    array = json_object_new_array();
    if (!canonical || !array) { if (array) json_object_put(array); goto done; }
    json_object_object_add(canonical, "type", json_object_new_string("call"));
    json_object_object_add(canonical, "method", json_object_new_string(method));
    json_object_array_add(array, r->kind ? json_object_new_int64(number) : json_object_new_object());
    json_object_object_add(canonical, "args", array);
    json = json_object_to_json_string_ext(canonical, JSON_C_TO_STRING_PLAIN);
    if (!json) goto done;
    json_len = strlen(json);
    r->wire_len = 1 + 4 + 2 + json_len + 4 + 34;
    if (r->wire_len > REQUEST_MAX || !(r->wire = malloc(r->wire_len))) goto done;
    r->wire[0] = 0x12;
    put_be32(r->wire + 1, (uint32_t)(json_len + 2));
    memcpy(r->wire + 5, "j:", 2);
    memcpy(r->wire + 7, json, json_len);
    put_be32(r->wire + 7 + json_len, 34);
    memcpy(r->wire + 11 + json_len, "s:", 2);
    memcpy(r->wire + 13 + json_len, r->id, 32);
    result = r->kind;
done:
    free(decoded);
    if (body) json_object_put(body);
    if (canonical) json_object_put(canonical);
    if (result < 0) { free(r->wire); r->wire = NULL; }
    return result;
}

int bridge_control_kind(const char *op, struct json_object *params)
{
    if (!op) return -1;
    if (!strcmp(op, "systemctl")) {
        struct ctl_request r;
        return parse_systemctl(params, &r);
    }
    if (!strcmp(op, "pm2")) {
        struct pm_request r;
        int kind = parse_pm2(params, &r);
        free(r.wire);
        return kind;
    }
    return -1;
}

static int time_left(int64_t deadline)
{
    int64_t left = deadline - monotonic_ms();
    if (left <= 0) return 0;
    return left > INT_MAX ? INT_MAX : (int)left;
}

static int wait_fd(int fd, short events, int64_t deadline)
{
    struct pollfd p = { .fd = fd, .events = events };
    for (;;) {
        int left = time_left(deadline), rc;
        if (!left) return 0;
        rc = poll(&p, 1, left);
        if (rc < 0 && errno == EINTR) continue;
        if (rc <= 0) return rc;
        if (p.revents & POLLNVAL) return -1;
        if (p.revents & (events | POLLERR | POLLHUP)) return 1;
    }
}

static int same_node(const struct stat *a, const struct stat *b)
{
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
           a->st_uid == b->st_uid && a->st_mode == b->st_mode;
}

struct manager_user {
    uid_t uid;
    gid_t gid;
    char name[256];
    char home[PATH_MAX];
    char runtime[64];
    char manager[88];
    char bus[96];
    struct stat runtime_stat;
    struct stat manager_stat;
    struct stat bus_stat;
};

static int trusted_user(uid_t uid, struct manager_user *u)
{
    struct passwd pw, *found = NULL;
    char *storage = NULL;
    size_t capacity = 4096;
    int run = -1, users = -1, runtime = -1, manager = -1, rc = -1;
    struct stat st;
    char number[24];
    memset(u, 0, sizeof(*u));
    while (capacity <= 65536) {
        free(storage);
        storage = malloc(capacity);
        if (!storage) goto done;
        rc = getpwuid_r(uid, &pw, storage, capacity, &found);
        if (rc != ERANGE) break;
        capacity *= 2;
    }
    if (rc != 0) { rc = -1; goto done; }
    rc = -1;
    if (!found || found->pw_uid != uid || !found->pw_name || !*found->pw_name ||
        strlen(found->pw_name) >= sizeof(u->name) || !found->pw_dir ||
        !valid_path(found->pw_dir) || strlen(found->pw_dir) >= sizeof(u->home) ||
        found->pw_gid == (gid_t)-1) goto done;
    u->uid = uid; u->gid = found->pw_gid;
    strcpy(u->name, found->pw_name); strcpy(u->home, found->pw_dir);
    snprintf(number, sizeof(number), "%lu", (unsigned long)uid);
    snprintf(u->runtime, sizeof(u->runtime), "/run/user/%s", number);
    snprintf(u->manager, sizeof(u->manager), "%s/systemd", u->runtime);
    snprintf(u->bus, sizeof(u->bus), "%s/private", u->manager);
    run = open("/run", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (run < 0 || fstat(run, &st) || st.st_uid || (st.st_mode & 0022)) goto done;
    users = openat(run, "user", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (users < 0 || fstat(users, &st) || st.st_uid || (st.st_mode & 0022)) goto done;
    runtime = openat(users, number, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (runtime < 0 || fstat(runtime, &u->runtime_stat) || u->runtime_stat.st_uid != uid ||
        (u->runtime_stat.st_mode & 07777) != 0700) goto done;
    /* systemctl's user-manager connection uses systemd/private and does not
     * require dbus-user-session. Pin that same endpoint for any D-Bus fallback;
     * never validate one socket while allowing an unverified session bus. */
    manager = openat(runtime, "systemd", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (manager < 0 || fstat(manager, &u->manager_stat) ||
        u->manager_stat.st_uid != uid || (u->manager_stat.st_mode & 0022)) goto done;
    if (fstatat(manager, "private", &u->bus_stat, AT_SYMLINK_NOFOLLOW) ||
        !S_ISSOCK(u->bus_stat.st_mode) || u->bus_stat.st_uid != uid ||
        (u->bus_stat.st_mode & 0077) || !(u->bus_stat.st_mode & 0200)) goto done;
    rc = 0;
done:
    if (manager >= 0) close(manager);
    if (runtime >= 0) close(runtime);
    if (users >= 0) close(users);
    if (run >= 0) close(run);
    free(storage);
    return rc;
}

static int user_unchanged(const struct manager_user *u)
{
    struct stat runtime, manager, bus;
    return !lstat(u->runtime, &runtime) && !lstat(u->manager, &manager) &&
           !lstat(u->bus, &bus) && same_node(&runtime, &u->runtime_stat) &&
           same_node(&manager, &u->manager_stat) && same_node(&bus, &u->bus_stat);
}

/* Workers intentionally have fd 0/1/2 closed; fd 3/4 belong to the main
 * bridge. Keep our descriptors above them so dup2 cannot clobber executable,
 * stdin or the other pipe, and close() cannot accidentally close new stdio. */
static int above_stdio(int fd)
{
    int moved;
    if (fd < 0 || fd >= 5) return fd;
    moved = fcntl(fd, F_DUPFD_CLOEXEC, 5);
    close(fd);
    return moved;
}

static int systemctl_binary(void)
{
    static const char *const paths[] = { "/usr/bin/systemctl", "/bin/systemctl", NULL };
    size_t i;
    for (i = 0; paths[i]; ++i) {
        struct stat st;
        int fd = above_stdio(open(paths[i], O_RDONLY | O_CLOEXEC | O_NONBLOCK));
        if (fd < 0) continue;
        if (!fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_uid == 0 &&
            !(st.st_mode & 0022) && (st.st_mode & 0111)) return fd;
        close(fd);
    }
    return -1;
}

/* Do not wait indefinitely for an uninterruptible exec child. The main process
 * owns group cleanup and must perform it even after an ordinary worker reply. */
static void reap_child(pid_t child, int terminate)
{
    int64_t deadline;
    if (child <= 0) return;
    if (terminate) kill(child, SIGKILL);
    deadline = monotonic_ms() + 50;
    while (waitpid(child, NULL, WNOHANG) == 0 && time_left(deadline)) poll(NULL, 0, 1);
}

static const char *signal_name(int number, char fallback[24])
{
    switch (number) {
        case SIGTERM: return "SIGTERM";
        case SIGKILL: return "SIGKILL";
        case SIGINT: return "SIGINT";
        case SIGQUIT: return "SIGQUIT";
        case SIGHUP: return "SIGHUP";
        case SIGABRT: return "SIGABRT";
        case SIGSEGV: return "SIGSEGV";
        case SIGPIPE: return "SIGPIPE";
        case SIGALRM: return "SIGALRM";
        case SIGBUS: return "SIGBUS";
        case SIGILL: return "SIGILL";
        case SIGFPE: return "SIGFPE";
        default: snprintf(fallback, 24, "SIG%d", number); return fallback;
    }
}

struct json_object *bridge_systemctl(struct json_object *params)
{
    struct ctl_request r;
    struct manager_user user;
    struct json_object *result = NULL;
    int pipes[2][2] = { { -1, -1 }, { -1, -1 } };
    int executable = -1, input = -1, status = 0, exited = 0;
    pid_t child = -1, worker = getpid();
    char *outputs[2] = { NULL, NULL }, signal_text[24];
    size_t used[2] = { 0, 0 }, i, argc = 0;
    char *argv[CONTROL_ARGS + 16];
    char home_env[PATH_MAX + 6], user_env[262], runtime_env[96], bus_env[144];
    char *env[12] = {
        "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
        "SYSTEMD_PAGER=cat", "SYSTEMD_COLORS=0", "SYSTEMD_PAGERSECURE=1",
        NULL, NULL, NULL, NULL, NULL, NULL
    };
    const char *failure = "manager-unavailable";
    const char *message = "Unable to run the verified systemd operation";
    int64_t deadline;
    if (parse_systemctl(params, &r) < 0) return error_result("forbidden", "Unsupported systemd request");
    if (getpgrp() != worker) return error_result("forbidden", "An isolated request worker is required");
    deadline = monotonic_ms() + r.timeout;
    if (r.user && trusted_user(r.uid, &user))
        return error_result("manager-unavailable", "A verified user manager is required");
    executable = systemctl_binary();
    if (executable < 0) goto done;
    input = above_stdio(open("/dev/null", O_RDONLY | O_CLOEXEC));
    if (input < 0) goto done;
    for (i = 0; i < 2; ++i) {
        if (pipe2(pipes[i], O_CLOEXEC | O_NONBLOCK)) goto done;
        pipes[i][0] = above_stdio(pipes[i][0]);
        pipes[i][1] = above_stdio(pipes[i][1]);
        if (pipes[i][0] < 0 || pipes[i][1] < 0) goto done;
        outputs[i] = malloc((size_t)CONTROL_MAX + 1);
        if (!outputs[i]) goto done;
    }
    argv[argc++] = "systemctl";
    argv[argc++] = "--no-ask-password";
    argv[argc++] = "--no-pager";
    argv[argc++] = r.user ? "--user" : "--system";
    argv[argc++] = (char *)r.command;
    if (r.flags & OPT_ALL) argv[argc++] = "--all";
    if (r.flags & OPT_TYPE) argv[argc++] = "--type=service";
    if (r.flags & OPT_LEGEND) argv[argc++] = "--no-legend";
    if (r.flags & OPT_PLAIN) argv[argc++] = "--plain";
    if (r.property) argv[argc++] = (char *)r.property;
    if (r.unit_count) argv[argc++] = "--";
    for (i = 0; i < r.unit_count; ++i) argv[argc++] = (char *)r.units[i];
    argv[argc] = NULL;
    if (r.user) {
        snprintf(home_env, sizeof(home_env), "HOME=%s", user.home);
        snprintf(user_env, sizeof(user_env), "USER=%s", user.name);
        snprintf(runtime_env, sizeof(runtime_env), "XDG_RUNTIME_DIR=%s", user.runtime);
        snprintf(bus_env, sizeof(bus_env), "DBUS_SESSION_BUS_ADDRESS=unix:path=%s", user.bus);
        env[6] = home_env; env[7] = user_env; env[8] = runtime_env; env[9] = bus_env;
    } else env[6] = "HOME=/";
    if (!time_left(deadline)) { failure = "manager-timeout"; message = "Systemd operation timed out"; goto done; }
    child = fork();
    if (child < 0) goto done;
    if (child == 0) {
        int sig;
        sigset_t empty;
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != worker) _exit(125);
        sigemptyset(&empty);
        if (sigprocmask(SIG_SETMASK, &empty, NULL)) _exit(125);
        for (sig = 1; sig < NSIG; ++sig) if (sig != SIGKILL && sig != SIGSTOP) signal(sig, SIG_DFL);
        if (clearenv()) _exit(125);
        if (dup2(input, STDIN_FILENO) < 0 || dup2(pipes[0][1], STDOUT_FILENO) < 0 ||
            dup2(pipes[1][1], STDERR_FILENO) < 0) _exit(125);
        if (fcntl(STDOUT_FILENO, F_SETFL, 0) < 0 || fcntl(STDERR_FILENO, F_SETFL, 0) < 0) _exit(125);
        close(input);
        for (i = 0; i < 2; ++i) { close(pipes[i][0]); close(pipes[i][1]); }
        if (r.user) {
            if (!user_unchanged(&user) || initgroups(user.name, user.gid) ||
                setgid(user.gid) || setuid(user.uid) || getuid() != user.uid ||
                geteuid() != user.uid || getgid() != user.gid || getegid() != user.gid ||
                prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != worker ||
                !user_unchanged(&user)) _exit(125);
        }
        if (chdir("/") || getppid() != worker) _exit(125);
        fexecve(executable, argv, env);
        _exit(126);
    }
    close(executable); executable = -1;
    close(input); input = -1;
    for (i = 0; i < 2; ++i) { close(pipes[i][1]); pipes[i][1] = -1; }
    while (!exited || pipes[0][0] >= 0 || pipes[1][0] >= 0) {
        struct pollfd fds[2];
        int left = time_left(deadline), polled;
        if (!left) { failure = "manager-timeout"; message = "Systemd operation timed out"; goto done; }
        if (!exited) {
            pid_t waited = waitpid(child, &status, WNOHANG);
            if (waited == child) exited = 1;
            else if (waited < 0 && errno != EINTR) goto done;
        }
        for (i = 0; i < 2; ++i) { fds[i].fd = pipes[i][0]; fds[i].events = POLLIN; fds[i].revents = 0; }
        if (exited && pipes[0][0] < 0 && pipes[1][0] < 0) break;
        polled = poll(fds, 2, left > 50 ? 50 : left);
        if (polled < 0) { if (errno == EINTR) continue; goto done; }
        for (i = 0; i < 2; ++i) {
            unsigned char chunk[16384];
            ssize_t n;
            size_t remaining;
            if (pipes[i][0] < 0 || !(fds[i].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) continue;
            if (fds[i].revents & POLLNVAL) goto done;
            remaining = (size_t)CONTROL_MAX - used[0] - used[1];
            n = read(pipes[i][0], chunk, remaining < sizeof(chunk) ? remaining + 1 : sizeof(chunk));
            if (n < 0) { if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue; goto done; }
            if (!n) { close(pipes[i][0]); pipes[i][0] = -1; continue; }
            if ((size_t)n > remaining) { message = "Systemd output exceeded the limit"; goto done; }
            memcpy(outputs[i] + used[i], chunk, (size_t)n);
            used[i] += (size_t)n;
        }
    }
    if (WIFEXITED(status) && (WEXITSTATUS(status) == 125 || WEXITSTATUS(status) == 126)) goto done;
    result = json_object_new_object();
    if (!result) goto done;
    json_object_object_add(result, "stdout", json_object_new_string_len(outputs[0], (int)used[0]));
    json_object_object_add(result, "stderr", json_object_new_string_len(outputs[1], (int)used[1]));
    json_object_object_add(result, "code", WIFEXITED(status) ? json_object_new_int(WEXITSTATUS(status)) : NULL);
    json_object_object_add(result, "signal", WIFSIGNALED(status) ?
        json_object_new_string(signal_name(WTERMSIG(status), signal_text)) : NULL);
done:
    if (child > 0 && !exited) reap_child(child, 1);
    if (executable >= 0) close(executable);
    if (input >= 0) close(input);
    for (i = 0; i < 2; ++i) {
        if (pipes[i][0] >= 0) close(pipes[i][0]);
        if (pipes[i][1] >= 0) close(pipes[i][1]);
        free(outputs[i]);
    }
    return result ? result : error_result(failure, message);
}

/* /proc/net/unix reports the kernel socket inode, NOT the filesystem inode
 * returned by lstat(rpc.sock). Match it separately from the pathname race check. */
static int kernel_socket_matches(const char *path, const char *inode, int64_t deadline)
{
    FILE *file;
    char line[8192];
    size_t total = 0;
    int matched = 0;
    if (!inode) return 1;
    file = fopen("/proc/net/unix", "re");
    if (!file) return 0;
    while (time_left(deadline) && fgets(line, sizeof(line), file)) {
        char *cursor = line, *start, *number = NULL;
        size_t col;
        total += strlen(line);
        if (total > CONTROL_MAX || !strchr(line, '\n')) break;
        for (col = 0; col < 7; ++col) {
            while (*cursor == ' ' || *cursor == '\t') ++cursor;
            start = cursor;
            while (*cursor && *cursor != ' ' && *cursor != '\t' && *cursor != '\n') ++cursor;
            if (start == cursor || !*cursor) break;
            *cursor++ = '\0';
            if (col == 6) number = start;
        }
        if (!number) continue;
        while (*cursor == ' ' || *cursor == '\t') ++cursor;
        cursor[strcspn(cursor, "\r\n")] = '\0';
        if (!strcmp(cursor, path) && !strcmp(number, inode)) { matched = 1; break; }
    }
    fclose(file);
    return matched;
}

static int pm_identity(int fd, const struct pm_request *r, const char *start)
{
    struct ucred credentials;
    socklen_t length = sizeof(credentials);
    char current[32];
    return !getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) &&
           length == sizeof(credentials) && credentials.uid == r->uid &&
           credentials.pid == r->pid && read_proc_start(r->pid, current) == 0 &&
           !strcmp(current, start);
}

static int valid_response(const unsigned char *buf, size_t len, const char *id)
{
    static const char *const keys[] = { "args", "error", "stack", NULL };
    struct json_object *body, *args, *error, *stack;
    size_t offsets[2], sizes[2];
    int valid = 0;
    if (amp_frame(buf, len, CONTROL_MAX, offsets, sizes) != 1 ||
        sizes[1] != 34 || memcmp(buf + offsets[1], "s:", 2) ||
        memcmp(buf + offsets[1] + 2, id, 32) || memcmp(buf + offsets[0], "j:", 2)) return 0;
    body = parse_json(buf + offsets[0] + 2, sizes[0] - 2);
    if (!object_keys(body, keys)) goto done;
    args = member(body, "args"); error = member(body, "error"); stack = member(body, "stack");
    if (error) {
        valid = !args && (json_object_is_type(error, json_type_string) ||
                         json_object_is_type(error, json_type_object)) && (!stack || text(stack));
    } else valid = args && json_object_is_type(args, json_type_array) && !stack &&
                   json_object_object_length(body) == 1;
done:
    if (body) json_object_put(body);
    return valid;
}

struct json_object *bridge_pm2(struct json_object *params)
{
    struct pm_request r;
    struct json_object *result = NULL;
    struct sockaddr_un address;
    struct stat home_stat, socket_stat, current;
    unsigned char *output = NULL;
    char *home = NULL, *canonical = NULL, *encoded = NULL;
    char socket_path[PATH_MAX], start[32];
    const char *failure = "manager-unavailable", *message = "Unable to connect to the verified PM2 daemon";
    int fd = -1, rc;
    size_t received = 0, sent = 0, offsets[2], sizes[2];
    int64_t deadline;
    if (parse_pm2(params, &r) < 0) return error_result("forbidden", "Unsupported PM2 request");
    deadline = monotonic_ms() + r.timeout;
    if (read_proc_start(r.pid, start) != 0 || (r.start_time && strcmp(start, r.start_time))) goto changed;
    home = realpath(r.home, NULL);
    if (!home || lstat(home, &home_stat) || !S_ISDIR(home_stat.st_mode) || home_stat.st_uid != r.uid) goto changed;
    rc = snprintf(socket_path, sizeof(socket_path), "%s%srpc.sock", home, !strcmp(home, "/") ? "" : "/");
    if (rc < 0 || (size_t)rc >= sizeof(socket_path) || strlen(socket_path) >= sizeof(address.sun_path)) goto changed;
    if (lstat(socket_path, &socket_stat) || !S_ISSOCK(socket_stat.st_mode) || socket_stat.st_uid != r.uid) goto changed;
    canonical = realpath(socket_path, NULL);
    if (!canonical || strcmp(canonical, socket_path) ||
        !kernel_socket_matches(socket_path, r.socket_inode, deadline)) goto changed;
    fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) goto done;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    strcpy(address.sun_path, canonical);
    rc = connect(fd, (struct sockaddr *)&address, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + strlen(canonical) + 1));
    if (rc < 0) {
        int error;
        socklen_t error_len = sizeof(error);
        if (errno != EINPROGRESS && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) goto done;
        rc = wait_fd(fd, POLLOUT, deadline);
        if (!rc) goto timed_out;
        if (rc < 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &error_len) || error) goto done;
    }
    if (lstat(socket_path, &current) || !same_node(&socket_stat, &current) ||
        lstat(home, &current) || !same_node(&home_stat, &current) ||
        !kernel_socket_matches(socket_path, r.socket_inode, deadline) || !pm_identity(fd, &r, start)) goto changed;
    while (sent < r.wire_len) {
        ssize_t n;
        if (!time_left(deadline)) goto timed_out;
        n = send(fd, r.wire + sent, r.wire_len - sent, MSG_NOSIGNAL);
        if (n > 0) { sent += (size_t)n; continue; }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            rc = wait_fd(fd, POLLOUT, deadline);
            if (!rc) goto timed_out;
            if (rc > 0) continue;
        }
        goto done;
    }
    output = malloc((size_t)CONTROL_MAX + 1);
    if (!output) goto done;
    for (;;) {
        ssize_t n;
        if (!time_left(deadline)) goto timed_out;
        n = recv(fd, output + received, (size_t)CONTROL_MAX + 1 - received, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            rc = wait_fd(fd, POLLIN, deadline);
            if (!rc) goto timed_out;
            if (rc > 0) continue;
        }
        if (n <= 0) goto done;
        received += (size_t)n;
        if (received > CONTROL_MAX) { message = "PM2 response exceeded the limit"; goto done; }
        rc = amp_frame(output, received, CONTROL_MAX, offsets, sizes);
        if (rc < 0) { message = "Invalid PM2 response frame"; goto done; }
        if (rc == 1) {
            unsigned char extra;
            n = recv(fd, &extra, 1, MSG_PEEK | MSG_DONTWAIT);
            if (n > 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) goto done;
            break;
        }
    }
    if (!valid_response(output, received, r.id)) { message = "Invalid PM2 response"; goto done; }
    if (!pm_identity(fd, &r, start) || lstat(socket_path, &current) || !same_node(&socket_stat, &current) ||
        lstat(home, &current) || !same_node(&home_stat, &current) ||
        !kernel_socket_matches(socket_path, r.socket_inode, deadline)) goto changed;
    if (!time_left(deadline)) goto timed_out;
    encoded = b64_encode(output, received);
    if (!encoded || !(result = json_object_new_object())) goto done;
    json_object_object_add(result, "buffer", json_object_new_string(encoded));
    goto done;
changed:
    failure = "identity-changed";
    message = "PM2 daemon identity could not be verified";
    goto done;
timed_out:
    failure = "manager-timeout";
    message = "PM2 operation timed out";
done:
    if (fd >= 0) close(fd);
    free(home); free(canonical); free(encoded); free(output); free(r.wire);
    return result ? result : error_result(failure, message);
}
