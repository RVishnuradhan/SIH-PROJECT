#pragma once

#include "driver/gpio.h"

/*
 * Pin assignment. Mirrors the "Pinout" table in the top-level README; change
 * both together.
 *
 * Deliberately avoided: GPIO 33-37 (octal PSRAM on R8 modules), 19/20 (native
 * USB), 3/45/46 (strapping) and 43/44 (console UART). GPIO 0 is only used
 * through the on-board BOOT button, below.
 */

/* I2S0: both INMP441s share these three lines. Mic 1 has L/R tied to GND and
 * answers in the left slot; mic 2 has L/R tied to 3V3 and answers in the right. */
#define PIN_MIC_BCLK  GPIO_NUM_4
#define PIN_MIC_WS    GPIO_NUM_5
#define PIN_MIC_DATA  GPIO_NUM_6

/* I2S1: MAX98357A. */
#define PIN_AMP_BCLK  GPIO_NUM_15
#define PIN_AMP_LRC   GPIO_NUM_16
#define PIN_AMP_DIN   GPIO_NUM_17
#define PIN_AMP_SD    GPIO_NUM_18   /* low = amp shut down */

/* I2C: SSD1306 OLED (used from firmware v2). */
#define PIN_OLED_SDA  GPIO_NUM_8
#define PIN_OLED_SCL  GPIO_NUM_9

/* The DevKit's own BOOT button (GPIO0, to GND with a pull-up on the board),
 * so no extra button is needed. GPIO0 is a strapping pin, which only matters
 * at reset: holding BOOT while resetting enters download mode, as usual.
 * Reading it as an input once the firmware is running is safe. */
#define PIN_BUTTON    GPIO_NUM_0
