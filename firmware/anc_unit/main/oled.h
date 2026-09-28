#pragma once
/*
 * 128x64 I2C OLED, text only: 8 rows of 21 characters, plus bar graphs.
 * Works with the SH1106 (1.3" modules) and the SSD1306 (0.96" modules); they
 * differ only in a 2-column offset, set by OLED_COLUMN_OFFSET in board.h.
 *
 * Draw into the frame buffer with oled_text()/oled_bar(), then oled_flush().
 * If no display answers at init, every call becomes a no-op, so the rest of
 * the firmware runs the same with or without a screen.
 */
#include <stdbool.h>

#include "esp_err.h"

#define OLED_ROWS 8
#define OLED_COLS 21

esp_err_t oled_init(void);
bool oled_present(void);
void oled_clear(void);
/* Text at a row (0-7) and character column (0-20); clipped at the edge. */
void oled_text(int row, int col, const char *s);
/* Horizontal bar across the row from pixel x0 to x1, filled `fraction` (0-1). */
void oled_bar(int row, int x0, int x1, float fraction);
esp_err_t oled_flush(void);
