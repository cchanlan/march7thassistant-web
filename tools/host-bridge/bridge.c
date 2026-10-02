/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 cchanlan
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 3 only.
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See LICENSE for the complete GNU General Public License version 3.
 */
#include "bridge.h"
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sched.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>

#define JOB_MAX 8
#define PATH_LIMIT 4096
#define REQUEST_MS 20000
static int proc_fd = -1;
static int authorized = 0, unsafe_write = 0;
static pid_t node_pid, bridge_pid;
static char node_start[32];
static struct stat node_root, node_mnt;
static struct json_object *host_scope;
static volatile sig_atomic_t terminating;

const char *jstr(struct json_object *o, const char *key) {
    struct json_object *v = NULL;
    if (!o || !json_object_object_get_ex(o, key, &v) || !json_object_is_type(v, json_type_string)) return NULL;
    const char *s = json_object_get_string(v);
    return s && strlen(s) == (size_t)json_object_get_string_len(v) ? s : NULL;
}
int64_t jint(struct json_object *o, const char *key, int64_t fallback) {
    struct json_object *v = NULL;
    return o && json_object_object_get_ex(o, key, &v) && json_object_is_type(v, json_type_int) ? json_object_get_int64(v) : fallback;
}
struct json_object *ok(void) { return json_object_new_object(); }
struct json_object *error_result(const char *code, const char *message) {
    struct json_object *r = ok(), *e = ok();
    json_object_object_add(e, "code", json_object_new_string(code));
    json_object_object_add(e, "message", json_object_new_string(message));
    json_object_object_add(r, "error", e);
    return r;
}
static struct json_object *syserr(void) {
    const char *code = "EIO";
    switch (errno) {
#define EC(n) case n: code = #n; break
        EC(ENOENT); EC(EACCES); EC(EPERM); EC(ENOTDIR); EC(EISDIR); EC(ELOOP); EC(EINVAL); EC(EFBIG); EC(ENOSPC); EC(EROFS); EC(EBUSY); EC(ETIMEDOUT); EC(ESTALE);
#undef EC
    }
    return error_result(code, "Host operation failed");
}
int valid_path(const char *s) { return s && s[0] == '/' && strlen(s) < PATH_LIMIT; }
int valid_utf8(const unsigned char *s, size_t n) {
    for (size_t i = 0; i < n;) {
        unsigned char a = s[i++]; size_t more;
        if (a < 0x80) continue;
        if (a >= 0xc2 && a <= 0xdf) more = 1;
        else if (a >= 0xe0 && a <= 0xef) more = 2;
        else if (a >= 0xf0 && a <= 0xf4) more = 3;
        else return 0;
        if (more > n - i) return 0;
        unsigned char b = s[i];
        if ((a == 0xe0 && b < 0xa0) || (a == 0xed && b >= 0xa0) ||
            (a == 0xf0 && b < 0x90) || (a == 0xf4 && b >= 0x90)) return 0;
        while (more--) if ((s[i++] & 0xc0) != 0x80) return 0;
    }
    return 1;
}
int64_t monotonic_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) return 0;
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
char *b64_encode(const unsigned char *src, size_t n) {
    if (n > WIRE_MAX) return NULL;
    char *out = malloc((n + 2) / 3 * 4 + 1);
    if (!out) return NULL;
    size_t a = 0, b = 0;
    while (a < n) {
        size_t left = n - a;
        unsigned x = (unsigned)src[a++] << 16;
        if (left > 1) x |= (unsigned)src[a++] << 8;
        if (left > 2) x |= src[a++];
        out[b++] = alphabet[(x >> 18) & 63]; out[b++] = alphabet[(x >> 12) & 63];
        out[b++] = left > 1 ? alphabet[(x >> 6) & 63] : '='; out[b++] = left > 2 ? alphabet[x & 63] : '=';
    }
    out[b] = 0; return out;
}
int b64_decode(const char *s, unsigned char **out, size_t *length, size_t max) {
    if (!s) return -1;
    size_t n = strlen(s);
    if (n % 4 || n > ((max + 2) / 3) * 4) return -1;
    unsigned char *b = malloc(n / 4 * 3 + 1);
    if (!b) return -1;
    size_t k = 0;
    for (size_t i = 0; i < n; i += 4) {
        unsigned v = 0; int pad = 0;
        for (int j = 0; j < 4; j++) {
            const char *p;
            if (s[i + (size_t)j] == '=') {
                if (i + 4 != n || j < 2) { free(b); return -1; }
                pad++; v <<= 6;
            } else {
                p = strchr(alphabet, s[i + (size_t)j]);
                if (!p || pad) { free(b); return -1; }
                v = (v << 6) | (unsigned)(p - alphabet);
            }
        }
        if (pad > 2 || (pad == 2 && (v & 0xffff)) || (pad == 1 && (v & 0xff))) { free(b); return -1; }
        b[k++] = (unsigned char)(v >> 16);
        if (pad < 2) b[k++] = (unsigned char)(v >> 8);
        if (!pad) b[k++] = (unsigned char)v;
    }
    if (k > max) { free(b); return -1; }
    b[k] = 0; *out = b; *length = k; return 0;
}
static int close_fds_from(int low) {
#ifdef SYS_close_range
    if (!syscall(SYS_close_range, (unsigned)low, ~0U, 0)) return 0;
#endif
    struct rlimit lim;
    if (getrlimit(RLIMIT_NOFILE, &lim)) return -1;
    /* The inherited hard limit is not lowered until inherited fds are closed. */
    for (rlim_t i = (rlim_t)low; i < lim.rlim_max && i <= INT_MAX; i++) close((int)i);
    return 0;
}
static int read_start_at(int base, pid_t pid, char out[32]) {
    char name[64], buf[8192];
    snprintf(name, sizeof(name), "%d/stat", (int)pid);
    int fd = openat(base, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    ssize_t n;
    do { n = read(fd, buf, sizeof(buf) - 1); } while (n < 0 && errno == EINTR);
    close(fd);
    if (n <= 0 || n >= (ssize_t)sizeof(buf) - 1) { errno = EIO; return -1; }
    buf[n] = 0;
    char *p = strrchr(buf, ')');
    if (!p || p[1] != ' ') { errno = EINVAL; return -1; }
    p += 2;
    if (*p == 'Z' || *p == 'X') { errno = ESTALE; return -1; }
    for (int field = 3; field < 22; field++) {
        p = strchr(p, ' ');
        if (!p) { errno = EINVAL; return -1; }
        while (*p == ' ') p++;
    }
    char *end = strchr(p, ' ');
    size_t len = end ? (size_t)(end - p) : strlen(p);
    if (!len || len >= 32 || strspn(p, "0123456789") < len) { errno = EINVAL; return -1; }
    memcpy(out, p, len); out[len] = 0; return 0;
}
int read_proc_start(pid_t pid, char out[32]) {
    if (proc_fd >= 0) return read_start_at(proc_fd, pid, out);
    int fd = open("/proc", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    int r = read_start_at(fd, pid, out); close(fd); return r;
}
static int same_inode(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static void add_u64(struct json_object *r, const char *k, uint64_t value) {
    char text[32]; snprintf(text, sizeof(text), "%llu", (unsigned long long)value);
    json_object_object_add(r, k, json_object_new_string(text));
}
static void add_i64(struct json_object *r, const char *k, int64_t value) {
    char text[32]; snprintf(text, sizeof(text), "%lld", (long long)value);
    json_object_object_add(r, k, json_object_new_string(text));
}
static struct json_object *stat_json(const struct stat *s) {
    struct json_object *r = ok();
    add_u64(r, "dev", s->st_dev); add_u64(r, "ino", s->st_ino); add_u64(r, "mode", s->st_mode);
    add_u64(r, "nlink", s->st_nlink); add_u64(r, "uid", s->st_uid); add_u64(r, "gid", s->st_gid);
    add_u64(r, "rdev", s->st_rdev); add_i64(r, "size", s->st_size); add_i64(r, "blksize", s->st_blksize); add_i64(r, "blocks", s->st_blocks);
    add_i64(r, "atimeNs", (int64_t)s->st_atim.tv_sec * 1000000000 + s->st_atim.tv_nsec);
    add_i64(r, "mtimeNs", (int64_t)s->st_mtim.tv_sec * 1000000000 + s->st_mtim.tv_nsec);
    add_i64(r, "ctimeNs", (int64_t)s->st_ctim.tv_sec * 1000000000 + s->st_ctim.tv_nsec);
    /* Linux stat does not promise birthtime. This matches unsupported Node stat. */
    add_i64(r, "birthtimeNs", 0); return r;
}
static struct json_object *identity_json(const char *actual, const struct stat *s) {
    struct json_object *r = ok();
    if (actual) json_object_object_add(r, "actual", json_object_new_string(actual));
    add_u64(r, "dev", s->st_dev); add_u64(r, "ino", s->st_ino); return r;
}
static char *link_path(const char *path) {
    char *s = malloc(PATH_LIMIT);
    if (!s) return NULL;
    ssize_t n = readlink(path, s, PATH_LIMIT - 1);
    if (n < 0 || n == PATH_LIMIT - 1) { free(s); if (n >= 0) errno = EFBIG; return NULL; }
    s[n] = 0; return s;
}
static struct json_object *scope_now(void) {
    struct stat root;
    char *mount = link_path("/proc/self/ns/mnt"), *pid = link_path("/proc/self/ns/pid");
    if (!mount || !pid || stat("/", &root)) { free(mount); free(pid); return NULL; }
    struct json_object *r = ok(), *ns = ok();
    json_object_object_add(ns, "mount", json_object_new_string(mount));
    json_object_object_add(ns, "pid", json_object_new_string(pid));
    json_object_object_add(r, "namespaces", ns);
    json_object_object_add(r, "rootIdentity", identity_json(NULL, &root));
    free(mount); free(pid); return r;
}
static int scope_equal(struct json_object *a, struct json_object *b) {
    struct json_object *an = NULL, *bn = NULL, *ar = NULL, *br = NULL;
    if (!a || !b || !json_object_object_get_ex(a, "namespaces", &an) || !json_object_object_get_ex(b, "namespaces", &bn) ||
        !json_object_object_get_ex(a, "rootIdentity", &ar) || !json_object_object_get_ex(b, "rootIdentity", &br)) return 0;
    const char *keys[] = {"mount", "pid", "dev", "ino"};
    for (int i = 0; i < 4; i++) {
        const char *x = jstr(i < 2 ? an : ar, keys[i]), *y = jstr(i < 2 ? bn : br, keys[i]);
        if (!x || !y || strcmp(x, y)) return 0;
    }
    return 1;
}
static int verified_parent(void) {
    char start[32], p[80]; struct stat root, mnt;
    if (getppid() != node_pid || read_proc_start(node_pid, start) || strcmp(start, node_start)) return 0;
    snprintf(p, sizeof(p), "%d/root", (int)node_pid);
    if (fstatat(proc_fd, p, &root, 0) || !same_inode(&root, &node_root)) return 0;
    snprintf(p, sizeof(p), "%d/ns/mnt", (int)node_pid);
    return !fstatat(proc_fd, p, &mnt, 0) && same_inode(&mnt, &node_mnt);
}
static int enter_host(void) {
    struct stat self_pid, init_pid, self_mnt, init_mnt, self_root, init_root, after;
    char initial_start[32], final_start[32], parent_path[80];
    int mount_fd = -1, root_fd = -1;
    if (getuid() != 0 || geteuid() != 0 || node_pid <= 1 || read_proc_start(1, initial_start) || read_proc_start(node_pid, node_start)) return -1;
    if (stat("/proc/self/ns/pid", &self_pid) || stat("/proc/1/ns/pid", &init_pid) || !same_inode(&self_pid, &init_pid) ||
        stat("/proc/self/ns/mnt", &self_mnt) || stat("/", &self_root)) return -1;
    mount_fd = open("/proc/1/ns/mnt", O_RDONLY | O_CLOEXEC);
    root_fd = open("/proc/1/root", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (mount_fd < 0 || root_fd < 0 || fstat(mount_fd, &init_mnt) || fstat(root_fd, &init_root) ||
        same_inode(&self_mnt, &init_mnt) || same_inode(&self_root, &init_root)) goto fail;
    snprintf(parent_path, sizeof(parent_path), "/proc/%d/root", (int)node_pid);
    if (stat(parent_path, &node_root) || !same_inode(&node_root, &self_root)) goto fail;
    snprintf(parent_path, sizeof(parent_path), "/proc/%d/ns/mnt", (int)node_pid);
    if (stat(parent_path, &node_mnt) || !same_inode(&node_mnt, &self_mnt)) goto fail;
    if (read_proc_start(1, final_start) || strcmp(initial_start, final_start) || setns(mount_fd, CLONE_NEWNS) ||
        fchdir(root_fd) || chroot(".") || chdir("/")) goto fail;
    if (stat("/", &after) || !same_inode(&after, &init_root) || stat("/proc/self/ns/mnt", &after) || !same_inode(&after, &init_mnt) ||
        stat("/proc/self/ns/pid", &after) || !same_inode(&after, &init_pid)) goto fail;
    proc_fd = open("/proc", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (proc_fd < 0 || read_proc_start(1, final_start) || strcmp(initial_start, final_start) || !verified_parent()) goto fail;
    host_scope = scope_now();
    close(mount_fd); close(root_fd); return host_scope ? 0 : -1;
fail:
    if (mount_fd >= 0) close(mount_fd);
    if (root_fd >= 0) close(root_fd);
    return -1;
}
static int read_bounded(int fd, size_t max, unsigned char **out, size_t *length) {
    unsigned char *b = malloc(max + 1);
    if (!b) { errno = ENOMEM; return -1; }
    size_t n = 0;
    while (n <= max) {
        ssize_t count = read(fd, b + n, max + 1 - n);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { free(b); return -1; }
        if (!count) break;
        n += (size_t)count;
    }
    if (n > max) { free(b); errno = EFBIG; return -1; }
    *out = b; *length = n; return 0;
}
static int fd_regular(int fd, struct stat *s) {
    if (fstat(fd, s)) return -1;
    if (!S_ISREG(s->st_mode)) { errno = EINVAL; return -1; }
    return 0;
}
static int open_regular(const char *path, int flags) {
    /* O_NONBLOCK does not make opening a device side-effect-free. Pin with
       O_PATH first, then reopen only the verified regular inode via /proc. */
    struct stat pinned, opened;
    int anchor = open(path, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (anchor < 0) return -1;
    if (fd_regular(anchor, &pinned)) { int saved = errno; close(anchor); errno = saved; return -1; }
    char link[80];
    if (proc_fd >= 0) snprintf(link, sizeof(link), "self/fd/%d", anchor);
    else snprintf(link, sizeof(link), "/proc/self/fd/%d", anchor);
    int fd = openat(proc_fd >= 0 ? proc_fd : AT_FDCWD, link, flags | O_CLOEXEC | O_NONBLOCK);
    int saved = errno;
    if (fd >= 0 && (fstat(fd, &opened) || !same_inode(&pinned, &opened))) { saved = ESTALE; close(fd); fd = -1; }
    close(anchor); errno = saved; return fd;
}
static struct json_object *read_file(struct json_object *p, int config) {
    const char *path = jstr(p, "path");
    int64_t lim = config ? CONFIG_MAX : jint(p, "limit", CONTROL_MAX);
    if (!valid_path(path) || lim < 0 || lim > CONTROL_MAX) return error_result("EINVAL", "Invalid file request");
    char *actual = realpath(path, NULL);
    if (!actual) return syserr();
    int fd = open_regular(actual, O_RDONLY);
    struct stat before, after, named; unsigned char *data = NULL; size_t n = 0;
    if (fd < 0) { free(actual); return syserr(); }
    if (fd_regular(fd, &before) || read_bounded(fd, (size_t)lim, &data, &n) || fstat(fd, &after) || stat(actual, &named) || !same_inode(&before, &named) ||
        (config && (before.st_size != after.st_size || before.st_mtim.tv_sec != after.st_mtim.tv_sec || before.st_mtim.tv_nsec != after.st_mtim.tv_nsec))) {
        if (!errno) errno = ESTALE;
        struct json_object *e = syserr(); close(fd); free(actual); free(data); return e;
    }
    char *base64 = b64_encode(data, n); free(data); close(fd);
    if (!base64) { free(actual); return error_result("ENOMEM", "Host resource limit"); }
    struct json_object *r = ok(); json_object_object_add(r, "data", json_object_new_string(base64)); free(base64);
    if (config) {
        json_object_object_add(r, "actual", json_object_new_string(actual));
        json_object_object_add(r, "stat", stat_json(&after));
        json_object_object_add(r, "identity", identity_json(actual, &after));
    }
    free(actual); return r;
}
static int write_all_at(int fd, const unsigned char *b, size_t n) {
    size_t at = 0;
    while (at < n) {
        ssize_t wrote = pwrite(fd, b + at, n - at, (off_t)at);
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) { if (!wrote) errno = EIO; return -1; }
        at += (size_t)wrote;
    }
    if (ftruncate(fd, (off_t)n) || fsync(fd)) return -1;
    return 0;
}
static int expected_identity(struct json_object *p, const struct stat *s) {
    const char *dev = jstr(p, "dev"), *ino = jstr(p, "ino"); char ds[32], is[32];
    snprintf(ds, sizeof(ds), "%llu", (unsigned long long)s->st_dev);
    snprintf(is, sizeof(is), "%llu", (unsigned long long)s->st_ino);
    return dev && ino && !strcmp(dev, ds) && !strcmp(ino, is);
}
static struct json_object *write_config(struct json_object *p) {
    const char *path = jstr(p, "path"), *expected_path = jstr(p, "expectedPath");
    struct json_object *expected = NULL, *result = NULL;
    unsigned char *original = NULL, *next = NULL, *current = NULL;
    size_t original_n = 0, next_n = 0, current_n = 0;
    int fd = -1, touched = 0; char *actual = NULL, *now = NULL; struct stat opened, named;
    if (!valid_path(path) || !valid_path(expected_path) || !json_object_object_get_ex(p, "expectedIdentity", &expected) ||
        b64_decode(jstr(p, "original"), &original, &original_n, CONFIG_MAX) || b64_decode(jstr(p, "next"), &next, &next_n, CONFIG_MAX)) {
        result = error_result("EINVAL", "Invalid configuration write"); goto done;
    }
    actual = realpath(path, NULL);
    if (!actual) { result = syserr(); goto done; }
    if (strcmp(actual, expected_path)) { result = error_result("ESTALE", "Configuration identity changed"); goto done; }
    fd = open_regular(actual, O_RDWR);
    if (fd < 0 || fd_regular(fd, &opened) || flock(fd, LOCK_EX | LOCK_NB)) { result = syserr(); goto done; }
    if (!expected_identity(expected, &opened)) { result = error_result("ESTALE", "Configuration identity changed"); goto done; }
    if (read_bounded(fd, CONFIG_MAX, &current, &current_n)) { result = syserr(); goto done; }
    now = realpath(path, NULL);
    if (!now || strcmp(now, actual) || lstat(actual, &named) || !same_inode(&opened, &named) || !S_ISREG(named.st_mode) ||
        original_n != current_n || memcmp(original, current, original_n)) { result = error_result("ESTALE", "Configuration changed"); goto done; }
    touched = 1;
    if (write_all_at(fd, next, next_n)) { result = syserr(); goto done; }
    free(now); now = realpath(path, NULL);
    if (!now || strcmp(now, actual) || lstat(actual, &named) || !same_inode(&opened, &named)) { result = error_result("ESTALE", "Configuration identity changed"); goto done; }
    result = ok();
done:
    if (result && json_object_object_get(result, "error")) {
        int rollback_failed = touched && fd >= 0 && write_all_at(fd, current, current_n);
        json_object_object_add(json_object_object_get(result, "error"), "unsafeToStart", json_object_new_boolean(1));
        if (rollback_failed) json_object_object_add(json_object_object_get(result, "error"), "rollbackFailed", json_object_new_boolean(1));
    }
    if (fd >= 0 && close(fd) && result && !json_object_object_get(result, "error")) {
        json_object_put(result); result = syserr();
        json_object_object_add(json_object_object_get(result, "error"), "unsafeToStart", json_object_new_boolean(1));
    }
    free(actual); free(now); free(original); free(next); free(current); return result;
}
static struct json_object *file_identity(const char *path) {
    if (!valid_path(path)) return error_result("EINVAL", "Invalid path");
    char *actual = realpath(path, NULL); struct stat s, named;
    if (!actual) return syserr();
    int fd = open(actual, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || fd_regular(fd, &s) || stat(actual, &named) || !same_inode(&s, &named)) {
        struct json_object *e = syserr(); if (fd >= 0) close(fd); free(actual); return e;
    }
    struct json_object *r = identity_json(actual, &s); close(fd); free(actual); return r;
}
static struct json_object *process_identity(struct json_object *p) {
    int64_t pid = jint(p, "pid", -1); const char *start = jstr(p, "startTime"), *file = jstr(p, "path");
    char before[32], after[32], root_path[64]; struct stat root, root_after;
    if (pid <= 0 || pid > INT_MAX || !start || !valid_path(file)) return error_result("EINVAL", "Invalid process identity");
    if (read_proc_start((pid_t)pid, before) || strcmp(before, start)) return error_result("ESTALE", "Process identity changed");
    snprintf(root_path, sizeof(root_path), "%d/root", (int)pid);
    int fd = openat(proc_fd, root_path, O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &root)) { if (fd >= 0) close(fd); return syserr(); }
    if (fchdir(fd) || chroot(".") || chdir("/")) { close(fd); return syserr(); }
    close(fd);
    /* This operation runs in a disposable worker. chroot gives absolute
       symlinks the target process's root semantics, not the observer's root. */
    struct json_object *r = file_identity(file);
    if (read_proc_start((pid_t)pid, after) || strcmp(before, after) || fstatat(proc_fd, root_path, &root_after, 0) || !same_inode(&root, &root_after)) {
        json_object_put(r); return error_result("ESTALE", "Process identity changed");
    }
    return r;
}
static int dirent_type(unsigned char type) {
    switch (type) {
        case DT_REG: return S_IFREG; case DT_DIR: return S_IFDIR; case DT_LNK: return S_IFLNK;
        case DT_BLK: return S_IFBLK; case DT_CHR: return S_IFCHR; case DT_FIFO: return S_IFIFO; case DT_SOCK: return S_IFSOCK;
        default: return 0;
    }
}
static struct json_object *filesystem(const char *op, struct json_object *p) {
    const char *path = jstr(p, "path");
    if (!valid_path(path)) return error_result("EINVAL", "Invalid host path");
    if (!strcmp(op, "readFile")) return read_file(p, 0);
    if (!strcmp(op, "readConfig")) return read_file(p, 1);
    if (!strcmp(op, "writeConfig")) return write_config(p);
    if (!strcmp(op, "fileIdentity")) return file_identity(path);
    if (!strcmp(op, "processFileIdentity")) return process_identity(p);
    if (!strcmp(op, "realpath") || !strcmp(op, "readlink")) {
        char *value = !strcmp(op, "realpath") ? realpath(path, NULL) : link_path(path);
        if (!value) return syserr();
        struct json_object *r = json_object_new_string(value); free(value); return r;
    }
    if (!strcmp(op, "stat") || !strcmp(op, "lstat")) {
        struct stat s;
        if ((!strcmp(op, "stat") ? stat(path, &s) : lstat(path, &s))) return syserr();
        return stat_json(&s);
    }
    if (!strcmp(op, "access")) {
        int64_t mode = jint(p, "mode", F_OK);
        if (mode < 0 || mode > 7) return error_result("EINVAL", "Invalid access mode");
        if (access(path, (int)mode)) return syserr();
        return ok();
    }
    if (!strcmp(op, "readdir")) {
        DIR *d = opendir(path); if (!d) return syserr();
        struct json_object *r = json_object_new_array(); struct dirent *entry; size_t budget = 0; int failed = 0;
        errno = 0;
        while ((entry = readdir(d))) {
            if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
            budget += strlen(entry->d_name) * 6 + 100;
            if (budget > CONTROL_MAX || json_object_array_length(r) >= 65536) { errno = EFBIG; failed = 1; break; }
            int type = dirent_type(entry->d_type);
            if (!type) {
                struct stat s;
                if (fstatat(dirfd(d), entry->d_name, &s, AT_SYMLINK_NOFOLLOW)) { failed = 1; break; }
                type = s.st_mode & S_IFMT;
            }
            struct json_object *item = ok();
            json_object_object_add(item, "name", json_object_new_string(entry->d_name));
            json_object_object_add(item, "type", json_object_new_int(type));
            json_object_array_add(r, item); errno = 0;
        }
        if (errno) failed = 1;
        struct json_object *e = failed ? syserr() : NULL; closedir(d);
        if (failed) { json_object_put(r); return e; }
        return r;
    }
    return error_result("ENOTSUP", "Unsupported host operation");
}
static struct json_object *response(int64_t id, struct json_object *value) {
    struct json_object *r = ok(), *e = NULL;
    json_object_object_add(r, "id", json_object_new_int64(id));
    if (value && json_object_object_get_ex(value, "error", &e)) json_object_object_add(r, "error", json_object_get(e));
    else json_object_object_add(r, "result", value ? json_object_get(value) : ok());
    if (value) json_object_put(value);
    return r;
}
static char *serialize(struct json_object *r, size_t *length) {
    const char *text = json_object_to_json_string_ext(r, JSON_C_TO_STRING_PLAIN);
    size_t n = text ? strlen(text) : WIRE_MAX + 1;
    if (n > WIRE_MAX) return NULL;
    char *out = malloc(n + 2); if (!out) return NULL;
    memcpy(out, text, n); out[n++] = '\n'; out[n] = 0; *length = n; return out;
}
static int finite_json(struct json_object *value) {
    if (!value) return 1;
    if (json_object_is_type(value, json_type_double)) return isfinite(json_object_get_double(value));
    if (json_object_is_type(value, json_type_array)) {
        for (size_t i = 0; i < json_object_array_length(value); i++) if (!finite_json(json_object_array_get_idx(value, i))) return 0;
    } else if (json_object_is_type(value, json_type_object)) {
        json_object_object_foreach(value, key, item) { (void)key; if (!finite_json(item)) return 0; }
    }
    return 1;
}
struct json_object *parse_json_strict(const unsigned char *s, size_t n, int depth) {
    if (!n || n > WIRE_MAX || memchr(s, 0, n) || !valid_utf8(s, n)) return NULL;
    int non_ascii = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] >= 0x80) non_ascii = 1;
        if (s[i] == '\\') {
            /* Never let Unicode normalization repair an invalid escape such
               as backslash followed by a literal non-ASCII character. */
            if (++i >= n || !strchr("\"\\/bfnrtu", s[i])) return NULL;
            if (s[i] == 'u' && i + 4 < n && !memcmp(s + i + 1, "0000", 4)) return NULL;
        }
    }
    /* json-c 0.18 STRICT treats signed non-ASCII chars as control bytes.
       Validate UTF-8 independently and normalize only non-ASCII code points to
       JSON Unicode escapes. Do not disable STRICT or silently accept bad UTF-8. */
    char *ascii = NULL; const char *input = (const char *)s; size_t length = n;
    if (non_ascii) {
        ascii = malloc(n * 3 + 1);
        if (!ascii) return NULL;
        size_t at = 0;
        for (size_t i = 0; i < n;) {
            unsigned a = s[i++], cp; size_t more;
            if (a < 0x80) { ascii[at++] = (char)a; continue; }
            if (a < 0xe0) { cp = a & 0x1f; more = 1; }
            else if (a < 0xf0) { cp = a & 0x0f; more = 2; }
            else { cp = a & 7; more = 3; }
            while (more--) cp = (cp << 6) | (s[i++] & 0x3f);
            if (cp > 0xffff) {
                cp -= 0x10000;
                snprintf(ascii + at, 7, "\\u%04x", 0xd800u + ((cp >> 10) & 0x3ff)); at += 6;
                snprintf(ascii + at, 7, "\\u%04x", 0xdc00u + (cp & 0x3ff)); at += 6;
            } else { snprintf(ascii + at, 7, "\\u%04x", cp & 0xffff); at += 6; }
        }
        ascii[at] = 0; input = ascii; length = at;
    }
    struct json_tokener *tok = json_tokener_new_ex(depth);
    if (!tok) { free(ascii); return NULL; }
    json_tokener_set_flags(tok, JSON_TOKENER_STRICT);
    struct json_object *r = json_tokener_parse_ex(tok, input, (int)length);
    if (json_tokener_get_error(tok) != json_tokener_success || json_tokener_get_parse_end(tok) != length || !finite_json(r)) {
        if (r) json_object_put(r);
        r = NULL;
    }
    json_tokener_free(tok); free(ascii); return r;
}
static struct json_object *parse_line(const char *s, size_t n) {
    struct json_object *r = parse_json_strict((const unsigned char *)s, n, 32);
    if (r && !json_object_is_type(r, json_type_object)) { json_object_put(r); return NULL; }
    return r;
}
struct job {
    pid_t pid; int fd; int64_t id, deadline; int writing, done;
    char *buffer; size_t length, capacity;
};
static struct job jobs[JOB_MAX];
static pid_t retired[JOB_MAX * 4];
static void reap_children(void) {
    for (size_t i = 0; i < sizeof(retired) / sizeof(retired[0]); i++) {
        if (retired[i] > 0) {
            pid_t result = waitpid(retired[i], NULL, WNOHANG);
            if (result == retired[i] || (result < 0 && errno == ECHILD)) retired[i] = 0;
        }
    }
}
static void stop_job(struct job *j) {
    if (j->pid > 0) {
        /* Do not reap an active worker before killing its group: a reaped PID
           could be reused by an unrelated process between poll iterations. */
        kill(-j->pid, SIGKILL); kill(j->pid, SIGKILL);
        if (waitpid(j->pid, NULL, WNOHANG) == 0) {
            int saved = 0;
            for (size_t i = 0; i < sizeof(retired) / sizeof(retired[0]); i++) if (!retired[i]) { retired[i] = j->pid; saved = 1; break; }
            if (!saved) terminating = 1;
        }
    }
    if (j->fd >= 0) close(j->fd);
    j->pid = 0; j->fd = -1;
}
static void job_result(struct job *j, struct json_object *value) {
    stop_job(j); free(j->buffer); j->buffer = NULL;
    if (j->writing && json_object_object_get(value, "error")) {
        unsafe_write = 1;
        json_object_object_add(json_object_object_get(value, "error"), "unsafeToStart", json_object_new_boolean(1));
    }
    struct json_object *r = response(j->id, value);
    j->buffer = serialize(r, &j->length); json_object_put(r); j->capacity = j->length; j->done = 1;
    if (!j->buffer) terminating = 1;
}
static void on_signal(int sig) { (void)sig; terminating = 1; }
static void worker(struct job *j, int output, const char *op, struct json_object *p) {
    if (setpgid(0, 0) || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != bridge_pid) _exit(111);
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    /* Retain only a private output fd and a host /proc anchor for rechecks. */
    int proc_copy = fcntl(proc_fd, F_DUPFD_CLOEXEC, 10), out_copy = fcntl(output, F_DUPFD_CLOEXEC, 10);
    if (proc_copy < 0 || out_copy < 0 || dup2(out_copy, 3) < 0 || dup2(proc_copy, 4) < 0) _exit(111);
    close(0); close(1); close(2); close_fds_from(5); proc_fd = 4;
    fcntl(3, F_SETFD, FD_CLOEXEC); fcntl(4, F_SETFD, FD_CLOEXEC);
    struct rlimit memory = {256U * 1024U * 1024U, 256U * 1024U * 1024U}, cpu = {20, 20}, files = {128, 128}, core = {0, 0};
    setrlimit(RLIMIT_AS, &memory); setrlimit(RLIMIT_CPU, &cpu); setrlimit(RLIMIT_NOFILE, &files); setrlimit(RLIMIT_CORE, &core);
    struct json_object *value = !strcmp(op, "systemctl") ? bridge_systemctl(p) : !strcmp(op, "pm2") ? bridge_pm2(p) : filesystem(op, p);
    struct json_object *r = response(j->id, value); size_t n = 0; char *text = serialize(r, &n); json_object_put(r);
    if (!text) _exit(111);
    size_t at = 0;
    while (at < n) {
        ssize_t count = write(3, text + at, n - at);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) _exit(111);
        at += (size_t)count;
    }
    free(text); close(3); _exit(0);
}
static int start_request(const char *line, size_t n) {
    struct json_object *r = parse_line(line, n), *p = NULL;
    if (!r) return -1;
    int64_t id = jint(r, "id", -1); const char *op = jstr(r, "op");
    if (id <= 0 || id > 9007199254740991LL || !op || !json_object_object_get_ex(r, "params", &p) || !json_object_is_type(p, json_type_object)) { json_object_put(r); return -1; }
    struct job *j = NULL;
    for (int k = 0; k < JOB_MAX; k++) {
        if (jobs[k].id == id) { json_object_put(r); return -1; }
        if (!jobs[k].id && !j) j = &jobs[k];
    }
    if (!j) { json_object_put(r); return -1; }
    j->id = id; j->fd = -1; j->writing = !strcmp(op, "writeConfig");
    if (!strcmp(op, "authorize")) {
        struct json_object *scope = NULL;
        const char *start = jstr(p, "startTime");
        if (jint(p, "pid", -1) == node_pid && start && !strcmp(start, node_start) &&
            json_object_object_get_ex(p, "scope", &scope) && scope_equal(scope, host_scope) && verified_parent()) {
            authorized = 1; job_result(j, ok());
        } else { authorized = 0; job_result(j, error_result("EAUTH", "Host authorization rejected")); }
        json_object_put(r); return 0;
    }
    if (!strcmp(op, "scope")) { job_result(j, json_object_get(host_scope)); json_object_put(r); return 0; }
    int kind = j->writing ? 1 : 0;
    if (!strcmp(op, "systemctl") || !strcmp(op, "pm2")) kind = bridge_control_kind(op, p);
    if (kind < 0) job_result(j, error_result("EPERM", "Host operation rejected"));
    else if (kind && (!authorized || !verified_parent())) { authorized = 0; job_result(j, error_result("EAUTH", "Host is not authorized")); }
    else if (kind > 0 && unsafe_write) job_result(j, error_result("EUNSAFE", "Host mutations are locked"));
    else {
        int fds[2];
        if (pipe2(fds, O_CLOEXEC)) job_result(j, syserr());
        else {
            pid_t child = fork();
            if (!child) { close(fds[0]); worker(j, fds[1], op, p); }
            close(fds[1]);
            if (child < 0) { close(fds[0]); job_result(j, syserr()); }
            else {
                j->pid = child; setpgid(child, child); j->fd = fds[0]; fcntl(j->fd, F_SETFL, O_NONBLOCK);
                int64_t timeout = jint(p, "timeout", 8000);
                if (timeout < 100) timeout = 100;
                if (timeout > REQUEST_MS - 1000) timeout = REQUEST_MS - 1000;
                j->deadline = monotonic_ms() + timeout + 750;
            }
        }
    }
    json_object_put(r); return 0;
}
static int run_bridge(void) {
    char *input = malloc(WIRE_MAX + 1), *output = NULL; size_t used = 0, out_n = 0, out_at = 0;
    int64_t partial_since = 0, blocked_since = 0;
    if (!input) return 1;
    struct json_object *hello = ok();
    json_object_object_add(hello, "version", json_object_new_int(1));
    json_object_object_add(hello, "scope", json_object_get(host_scope));
    json_object_object_add(hello, "pid", json_object_new_int64(node_pid));
    json_object_object_add(hello, "startTime", json_object_new_string(node_start));
    struct json_object *r = response(0, hello); output = serialize(r, &out_n); json_object_put(r);
    fcntl(0, F_SETFL, O_NONBLOCK); fcntl(1, F_SETFL, O_NONBLOCK);
    while (!terminating) {
        int64_t now = monotonic_ms();
        if (!verified_parent() || (used && partial_since && now - partial_since > 5000) || (blocked_since && now - blocked_since > 5000)) break;
        if (!output) for (int k = 0; k < JOB_MAX; k++) if (jobs[k].id && jobs[k].done) {
            output = jobs[k].buffer; out_n = jobs[k].length; out_at = 0;
            memset(&jobs[k], 0, sizeof(jobs[k])); jobs[k].fd = -1; break;
        }
        struct pollfd fds[JOB_MAX + 2];
        fds[0] = (struct pollfd){ .fd = 0, .events = POLLIN };
        fds[1] = (struct pollfd){ .fd = 1, .events = output ? POLLOUT : 0 };
        for (int k = 0; k < JOB_MAX; k++) fds[k + 2] = (struct pollfd){ .fd = jobs[k].fd, .events = POLLIN };
        int polled = poll(fds, JOB_MAX + 2, 100);
        if (polled < 0 && errno != EINTR) break;
        if (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL) || fds[1].revents & (POLLHUP | POLLERR | POLLNVAL)) break;
        if (output && fds[1].revents & POLLOUT) {
            ssize_t count = write(1, output + out_at, out_n - out_at);
            if (count > 0) { out_at += (size_t)count; blocked_since = 0; }
            else if (count < 0 && errno != EINTR && errno != EAGAIN) break;
            if (out_at == out_n) { free(output); output = NULL; out_at = out_n = 0; }
        }
        if (output && !blocked_since) blocked_since = now;
        if (fds[0].revents & POLLIN) {
            ssize_t count = read(0, input + used, WIRE_MAX - used);
            if (!count) break;
            if (count < 0 && errno != EINTR && errno != EAGAIN) break;
            if (count > 0) {
                if (!used) partial_since = now;
                used += (size_t)count; size_t offset = 0;
                for (;;) {
                    char *nl = memchr(input + offset, '\n', used - offset);
                    if (!nl) break;
                    size_t n = (size_t)(nl - input - offset);
                    if (start_request(input + offset, n)) { terminating = 1; break; }
                    offset += n + 1;
                }
                if (offset) { memmove(input, input + offset, used - offset); used -= offset; partial_since = used ? now : 0; }
                if (used == WIRE_MAX) break;
            }
        }
        for (int k = 0; k < JOB_MAX; k++) {
            struct job *j = &jobs[k];
            if (!j->id || j->done || j->fd < 0) continue;
            if (now > j->deadline) { job_result(j, error_result("ETIMEDOUT", "Host request timed out")); continue; }
            if (!(fds[k + 2].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            char chunk[65536]; ssize_t count = read(j->fd, chunk, sizeof(chunk));
            if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            if (count < 0 || j->length + (size_t)(count > 0 ? count : 0) > WIRE_MAX) { job_result(j, error_result("EFBIG", "Host response limit")); continue; }
            if (count > 0) {
                size_t need = j->length + (size_t)count + 1;
                if (need > j->capacity) {
                    size_t cap = need + 65536; char *grown = realloc(j->buffer, cap);
                    if (!grown) { job_result(j, error_result("ENOMEM", "Host resource limit")); continue; }
                    j->buffer = grown; j->capacity = cap;
                }
                memcpy(j->buffer + j->length, chunk, (size_t)count); j->length += (size_t)count; j->buffer[j->length] = 0;
            } else {
                struct json_object *message = j->length && j->buffer[j->length - 1] == '\n' ? parse_line(j->buffer, j->length - 1) : NULL;
                struct json_object *err = NULL, *value = NULL;
                if (!message || jint(message, "id", -1) != j->id) {
                    if (message) json_object_put(message);
                    job_result(j, error_result("EPROTO", "Host worker disconnected")); continue;
                }
                if (json_object_object_get_ex(message, "error", &err)) {
                    value = ok(); json_object_object_add(value, "error", json_object_get(err));
                } else if (json_object_object_get_ex(message, "result", &value)) value = json_object_get(value);
                else value = error_result("EPROTO", "Invalid host response");
                json_object_put(message); job_result(j, value);
            }
        }
        reap_children();
    }
    for (int k = 0; k < JOB_MAX; k++) { stop_job(&jobs[k]); free(jobs[k].buffer); }
    free(input); free(output); return 0;
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--version")) { puts("m7a-host-bridge 1"); return 0; }
    if (argc != 1) return 64;
    struct stat in, out; node_pid = getppid(); bridge_pid = getpid();
    if (fstat(0, &in) || fstat(1, &out) || !(S_ISFIFO(in.st_mode) || S_ISSOCK(in.st_mode)) || !(S_ISFIFO(out.st_mode) || S_ISSOCK(out.st_mode))) return 77;
    signal(SIGPIPE, SIG_IGN); signal(SIGTERM, on_signal); signal(SIGINT, on_signal);
    if (prctl(PR_SET_PDEATHSIG, SIGTERM) || getppid() != node_pid || close_fds_from(3)) return 77;
    struct rlimit core = {0, 0}; setrlimit(RLIMIT_CORE, &core);
    if (enter_host()) return 77;
    /* No inherited loader, language, credential or command environment crosses
       the host boundary. Control commands build their own fixed environment. */
    clearenv(); umask(077);
    for (int k = 0; k < JOB_MAX; k++) jobs[k].fd = -1;
    int code = run_bridge(); if (proc_fd >= 0) close(proc_fd); json_object_put(host_scope); return code;
}
