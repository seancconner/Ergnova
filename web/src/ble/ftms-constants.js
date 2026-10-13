// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// Bluetooth SIG Fitness Machine Service (FTMS) — spec constants.
// One service definition covers Indoor Bike, Rower, and Cross Trainer (elliptical);
// the machine type is read from Fitness Machine Feature / determined by which
// data characteristic notifies, so we don't need a separate stack per machine.

export const FTMS_SERVICE = 0x1826;

export const CHAR = {
  FEATURE: 0x2acc,
  INDOOR_BIKE_DATA: 0x2ad2,
  ROWER_DATA: 0x2ad1,
  CROSS_TRAINER_DATA: 0x2ace,
  TRAINING_STATUS: 0x2ad3,
  CONTROL_POINT: 0x2ad9,
  STATUS: 0x2ada,
  RESISTANCE_RANGE: 0x2ad6,
  POWER_RANGE: 0x2ad8,
};

export const HRS_SERVICE = 0x180d;
export const HRS_MEASUREMENT = 0x2a37;

// Control Point op codes (subset we actually use)
export const OP = {
  REQUEST_CONTROL: 0x00,
  RESET: 0x01,
  SET_TARGET_RESISTANCE: 0x04, // hundredths of a unit, machine-defined
  SET_TARGET_POWER: 0x05, // watts, signed int16
  SET_SIM_PARAMS: 0x11, // wind speed, grade, crr, cw — used for slope/grade mode
  START: 0x07,
  STOP: 0x08,
  RESPONSE_CODE: 0x80,
};

export const RESULT = {
  SUCCESS: 0x01,
  OP_NOT_SUPPORTED: 0x02,
  INVALID_PARAMETER: 0x03,
  OPERATION_FAILED: 0x04,
  CONTROL_NOT_PERMITTED: 0x05,
};

export const MACHINE_TYPE = {
  BIKE: 'bike',
  ROWER: 'rower',
  CROSS_TRAINER: 'cross_trainer',
  HR_ONLY: 'hr_only', // no FTMS machine at all — just a heart rate strap
};
