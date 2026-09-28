#include "dashboard.h"

#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

/* Core 0 belongs to the AI, which needs nearly all of every 10 ms block;
 * on core 0, WiFi (priority 23) and the network stack (18) cost firmware
 * 0.6.0 dropped blocks. Everything network runs on core 1 instead, next to
 * the audio task, which uses 1-2 ms per block and has 60 ms of DMA buffer.
 * sdkconfig is not in git: an sdkconfig made before 0.6.1 still has the old
 * setting, and `idf.py set-target esp32s3` rebuilds it from sdkconfig.defaults. */
#if !CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_1 || !CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU1
#error "WiFi must run on core 1: run `idf.py set-target esp32s3`, then `idf.py build`"
#endif
#define NET_CORE 1

static const char *TAG = "dashboard";

/* Channel 6 and at most 4 phones: this is a demo link, not a network. */
#define AP_CHANNEL 6
#define AP_MAX_CONN 4

extern const char page_start[] asm("_binary_dashboard_html_start");
extern const char page_end[] asm("_binary_dashboard_html_end");

static esp_err_t page_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    /* EMBED_TXTFILES adds a terminating NUL; do not send it. */
    return httpd_resp_send(req, page_start, page_end - page_start - 1);
}

static esp_err_t data_get(httpd_req_t *req)
{
    char json[512];
    dashboard_status_json(json, sizeof(json));
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, json);
}

static esp_err_t mode_get(httpd_req_t *req)
{
    char query[64], name[24];
    bool ok = httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK &&
              httpd_query_key_value(query, "m", name, sizeof(name)) == ESP_OK &&
              dashboard_set_mode(name);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, ok ? "{\"ok\":true}" : "{\"ok\":false}");
}

static esp_err_t start_wifi(void)
{
    esp_err_t err = nvs_flash_init();          /* the WiFi driver keeps calibration data here */
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_RETURN_ON_ERROR(nvs_flash_erase(), TAG, "nvs erase");
        err = nvs_flash_init();
    }
    ESP_RETURN_ON_ERROR(err, TAG, "nvs");
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "event loop");
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "wifi init");
    wifi_config_t ap = {
        .ap = {
            .ssid = DASHBOARD_SSID,
            .ssid_len = sizeof(DASHBOARD_SSID) - 1,
            .password = DASHBOARD_PASSWORD,
            .channel = AP_CHANNEL,
            .max_connection = AP_MAX_CONN,
            .authmode = WIFI_AUTH_WPA2_PSK,
        },
    };
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_AP), TAG, "wifi mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &ap), TAG, "wifi config");
    return esp_wifi_start();
}

static esp_err_t start_dashboard(void)
{
    ESP_RETURN_ON_ERROR(start_wifi(), TAG, "wifi");

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.core_id = NET_CORE;
    /* Far below the audio task: pages are served in its idle time. */
    cfg.task_priority = 3;
    cfg.stack_size = 6144;
    httpd_handle_t server;
    ESP_RETURN_ON_ERROR(httpd_start(&server, &cfg), TAG, "http server");
    const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = page_get},
        {.uri = "/data", .method = HTTP_GET, .handler = data_get},
        {.uri = "/mode", .method = HTTP_GET, .handler = mode_get},
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(server, &routes[i]);
    }
    ESP_LOGI(TAG, "WiFi \"%s\" (password %s): open http://192.168.4.1 on a phone",
             DASHBOARD_SSID, DASHBOARD_PASSWORD);
    return ESP_OK;
}

static void start_task(void *arg)
{
    /* The WiFi driver takes its interrupt on the core that starts it. */
    if (start_dashboard() != ESP_OK) {
        ESP_LOGW(TAG, "dashboard not started; everything else runs as normal");
    }
    vTaskDelete(NULL);
}

esp_err_t dashboard_start(void)
{
    BaseType_t ok = xTaskCreatePinnedToCore(start_task, "dash_start", 4096, NULL, 3, NULL, NET_CORE);
    return ok == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
