#include "oled.h"

#include <string.h>

#include "board.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_log.h"
#include "font5x7.h"

static const char *TAG = "oled";

#define WIDTH 128
#define PAGES 8
#define I2C_HZ 400000
#define TIMEOUT_MS 50

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_dev;
static bool s_present;
static uint8_t s_fb[PAGES][WIDTH];

static esp_err_t send_cmds(const uint8_t *cmds, size_t n)
{
    uint8_t buf[32];
    if (n + 1 > sizeof(buf)) return ESP_ERR_INVALID_SIZE;
    buf[0] = 0x00;                       /* control byte: commands follow */
    memcpy(buf + 1, cmds, n);
    return i2c_master_transmit(s_dev, buf, n + 1, TIMEOUT_MS);
}

/* Look for a display on one pin assignment; returns its address or 0.
 * Also logs every I2C device that answers, to tell wiring faults apart
 * (nothing at all: power or pins; something else: a different chip). */
static uint16_t find_display(int sda, int scl)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = sda,
        .scl_io_num = scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,   /* modules usually have their own too */
    };
    if (i2c_new_master_bus(&bus_cfg, &s_bus) != ESP_OK) return 0;
    uint16_t found = 0;
    for (uint16_t a = 0x08; a < 0x78; a++) {
        if (i2c_master_probe(s_bus, a, 10) == ESP_OK) {   /* short: 2 x 112 probes at boot */
            ESP_LOGI(TAG, "I2C device at 0x%02X (SDA=GPIO%d, SCL=GPIO%d)", a, sda, scl);
            if ((a == 0x3C || a == 0x3D) && !found) found = a;
        }
    }
    if (!found) {
        i2c_del_master_bus(s_bus);
        s_bus = NULL;
    }
    return found;
}

esp_err_t oled_init(void)
{
    /* Try the documented wiring, then SDA and SCL swapped: the labels on
     * these modules are easy to mix up, and trying both costs nothing. */
    uint16_t addr = find_display(PIN_OLED_SDA, PIN_OLED_SCL);
    if (!addr) {
        addr = find_display(PIN_OLED_SCL, PIN_OLED_SDA);
        if (addr) ESP_LOGW(TAG, "display answers with SDA and SCL swapped; using it that way");
    }
    if (!addr) {
        ESP_LOGW(TAG, "no display at 0x3C/0x3D on GPIO%d/GPIO%d either way round "
                 "(check VCC->3V3 and GND: on many 1.3\" modules the pin order is GND, VCC, SCL, SDA)",
                 PIN_OLED_SDA, PIN_OLED_SCL);
        return ESP_ERR_NOT_FOUND;
    }
    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = I2C_HZ,
    };
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(s_bus, &dev_cfg, &s_dev), TAG, "i2c device");

    /* Common to SH1106 and SSD1306 (0x8D 0x14 turns on the SSD1306 charge
     * pump and is ignored by the SH1106). Page addressing, the reset default
     * on both, is what oled_flush uses. */
    static const uint8_t init[] = {
        0xAE,             /* display off */
        0xD5, 0x80,       /* clock */
        0xA8, 0x3F,       /* 64 rows */
        0xD3, 0x00,       /* no vertical offset */
        0x40,             /* start line 0 */
        0x8D, 0x14,       /* charge pump (SSD1306) */
        0xA1,             /* column 127 = SEG0: not mirrored */
        0xC8,             /* scan rows top to bottom */
        0xDA, 0x12,       /* COM pins */
        0x81, 0xCF,       /* contrast */
        0xD9, 0xF1,       /* pre-charge */
        0xDB, 0x40,       /* VCOMH */
        0xA4,             /* show RAM */
        0xA6,             /* not inverted */
    };
    ESP_RETURN_ON_ERROR(send_cmds(init, sizeof(init)), TAG, "init");
    s_present = true;
    oled_clear();
    oled_flush();
    static const uint8_t on[] = {0xAF};
    ESP_RETURN_ON_ERROR(send_cmds(on, 1), TAG, "display on");
    ESP_LOGI(TAG, "display found at 0x%02X", addr);
    return ESP_OK;
}

bool oled_present(void)
{
    return s_present;
}

void oled_clear(void)
{
    memset(s_fb, 0, sizeof(s_fb));
}

void oled_text(int row, int col, const char *s)
{
    if (row < 0 || row >= PAGES) return;
    for (int x = col * 6; *s && x + 6 <= WIDTH; s++, x += 6) {
        unsigned char c = (unsigned char)*s;
        const uint8_t *g = FONT5X7[(c < 0x20 || c > 0x7E) ? '?' - 0x20 : c - 0x20];
        memcpy(&s_fb[row][x], g, 5);
        s_fb[row][x + 5] = 0;
    }
}

void oled_bar(int row, int x0, int x1, float fraction)
{
    if (row < 0 || row >= PAGES || x0 < 0 || x1 >= WIDTH || x1 <= x0) return;
    if (fraction < 0) fraction = 0;
    if (fraction > 1) fraction = 1;
    int fill = x0 + (int)(fraction * (x1 - x0) + 0.5f);
    for (int x = x0; x <= x1; x++) {
        /* outline on the edges and ends, solid up to `fill` */
        s_fb[row][x] = (x == x0 || x == x1 || x <= fill) ? 0x7E : 0x42;
    }
}

esp_err_t oled_flush(void)
{
    if (!s_present) return ESP_OK;
    uint8_t buf[1 + WIDTH];
    buf[0] = 0x40;                       /* control byte: display data follows */
    for (int p = 0; p < PAGES; p++) {
        const uint8_t pos[] = {
            (uint8_t)(0xB0 | p),
            (uint8_t)(0x00 | (OLED_COLUMN_OFFSET & 0x0F)),
            (uint8_t)(0x10 | (OLED_COLUMN_OFFSET >> 4)),
        };
        ESP_RETURN_ON_ERROR(send_cmds(pos, sizeof(pos)), TAG, "page");
        memcpy(buf + 1, s_fb[p], WIDTH);
        ESP_RETURN_ON_ERROR(i2c_master_transmit(s_dev, buf, sizeof(buf), TIMEOUT_MS), TAG, "data");
    }
    return ESP_OK;
}
