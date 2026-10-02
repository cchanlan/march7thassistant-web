/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 cchanlan
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 3 only.
 * Distributed WITHOUT ANY WARRANTY; see LICENSE for the complete terms.
 */
#ifndef M7A_HOST_BRIDGE_H
#define M7A_HOST_BRIDGE_H
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <json-c/json.h>
#define CONTROL_MAX (4U * 1024U * 1024U)
#define CONFIG_MAX (1024U * 1024U)
#define WIRE_MAX (16U * 1024U * 1024U)
const char *jstr(struct json_object *, const char *);
int64_t jint(struct json_object *, const char *, int64_t);
struct json_object *ok(void);
struct json_object *error_result(const char *, const char *);
int b64_decode(const char *, unsigned char **, size_t *, size_t);
char *b64_encode(const unsigned char *, size_t);
int read_proc_start(pid_t, char out[32]);
int64_t monotonic_ms(void);
int valid_path(const char *);
int valid_utf8(const unsigned char *, size_t);
struct json_object *parse_json_strict(const unsigned char *, size_t, int);
struct json_object *bridge_systemctl(struct json_object *);
struct json_object *bridge_pm2(struct json_object *);
int bridge_control_kind(const char *, struct json_object *);
#endif
