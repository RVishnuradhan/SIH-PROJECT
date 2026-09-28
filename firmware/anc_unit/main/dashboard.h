#pragma once
/*
 * Phone dashboard: the unit runs its own WiFi network (no router, no
 * internet) and serves a live status page at http://192.168.4.1.
 *
 *   GET /         the page (main/dashboard.html, built into the firmware)
 *   GET /data     status as JSON, polled by the page 4 times a second
 *   GET /mode?m=  set what the speaker plays: mute, raw, ai, two-mic, reference, tone
 *   GET /vol?d=   speaker volume one step up (d=1) or down (d=-1)
 */
#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

#define DASHBOARD_SSID "HERTZ-HUNTERS-ANC"
#define DASHBOARD_PASSWORD "hertz1234"

/* Starts WiFi and the web server on core 1 in the background; failures are
 * logged and leave the rest of the unit running. */
esp_err_t dashboard_start(void);

/* Implemented by the application (main.c). */
void dashboard_status_json(char *buf, size_t len);
bool dashboard_set_mode(const char *name);
void dashboard_change_volume(int delta);
