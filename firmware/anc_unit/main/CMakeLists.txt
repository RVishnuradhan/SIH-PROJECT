idf_component_register(
    SRCS "main.c" "audio_io.c" "host_link.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_driver_i2s esp_driver_gpio esp_driver_usb_serial_jtag
                  esp_psram esp_ringbuf esp_timer anc_core
)
