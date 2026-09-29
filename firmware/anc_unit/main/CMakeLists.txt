idf_component_register(
    SRCS "main.c" "audio_io.c" "host_link.c" "oled.c" "dashboard.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_driver_i2s esp_driver_gpio esp_driver_i2c esp_driver_usb_serial_jtag
                  esp_psram esp_ringbuf esp_timer esp_wifi esp_netif esp_event nvs_flash
                  esp_http_server anc_core anc_denoise
    # Neural suppressor weights, from tools/export_denoiser.py.
    EMBED_FILES "denoiser.bin"
    # The phone dashboard page, and the lab results (tools/benchmark_targets.py)
    # its Targets card shows.
    EMBED_TXTFILES "dashboard.html" "benchmark.json"
)
