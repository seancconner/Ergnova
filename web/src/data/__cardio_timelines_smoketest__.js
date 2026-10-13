// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 seancconner

// data/cardio-timelines.js smoke test. Run with:
//   node src/data/__cardio_timelines_smoketest__.js

import { STEP_TYPES, TARGET_TYPES, totalDuration } from '../core/cardio-model.js';
import {
  TARGET_STYLES, TIMELINE_GROUP_ORDER, BUILTIN_TIMELINE_PRESETS, createCustomTimelinePreset,
  allTimelinePresets, timelinePresetById, buildTimelineWorkout,
} from './cardio-timelines.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  - ${label}`);
  else { failures++; console.log(`FAIL  - ${label}`); }
}

console.log('cardio-timelines.js — TARGET_STYLES');
{
  check('has exactly free + steady + mapped', TARGET_STYLES.map(s => s.value).sort().join(',') === 'free,mapped,steady');
  check('Free is listed first (leftmost in the toggle)', TARGET_STYLES[0].value === 'free');
  check('every style has a label and blurb', TARGET_STYLES.every(s => s.label && s.blurb));
}

console.log('cardio-timelines.js — BUILTIN_TIMELINE_PRESETS');
{
  check('has exactly sixteen bundled presets', BUILTIN_TIMELINE_PRESETS.length === 16);
  check('covers 20/30/45/60 minutes, four each', BUILTIN_TIMELINE_PRESETS.map(p => p.durationMin).sort((a, b) => a - b).join(',') ===
    ['20', '20', '20', '20', '30', '30', '30', '30', '45', '45', '45', '45', '60', '60', '60', '60'].join(','));
  check('every preset id is unique', new Set(BUILTIN_TIMELINE_PRESETS.map(p => p.id)).size === BUILTIN_TIMELINE_PRESETS.length);
  check('every preset is flagged custom: false', BUILTIN_TIMELINE_PRESETS.every(p => p.custom === false));
  check('every preset has a non-empty label and tagline', BUILTIN_TIMELINE_PRESETS.every(p => p.label && p.tagline));

  // The whole point of a fixed-duration preset is that it actually plays
  // back to that duration — check the real totalDuration() math (interval
  // repeat*(on+off) included) against the declared durationMin, not just
  // trust the arithmetic in cardio-timelines.js's own comments.
  for (const preset of BUILTIN_TIMELINE_PRESETS) {
    const workout = buildTimelineWorkout(preset);
    const seconds = totalDuration(workout);
    check(`${preset.label}: totalDuration() is exactly ${preset.durationMin} minutes`, seconds === preset.durationMin * 60);
  }

  check('every preset\u2019s steps are warm-up ramp \u2192 interval \u2192 cool-down ramp',
    BUILTIN_TIMELINE_PRESETS.every(p =>
      p.steps.length === 3 &&
      p.steps[0].type === STEP_TYPES.RAMP &&
      p.steps[1].type === STEP_TYPES.INTERVAL &&
      p.steps[2].type === STEP_TYPES.RAMP));
  check('every step targets POWER', BUILTIN_TIMELINE_PRESETS.every(p => p.steps.every(s =>
    s.targetType === TARGET_TYPES.POWER
    && (s.type !== STEP_TYPES.INTERVAL || (s.onStep.targetType === TARGET_TYPES.POWER && s.offStep.targetType === TARGET_TYPES.POWER)))));
  check('every preset has a group from TIMELINE_GROUP_ORDER',
    BUILTIN_TIMELINE_PRESETS.every(p => TIMELINE_GROUP_ORDER.includes(p.group)));
  check('every group in TIMELINE_GROUP_ORDER has four presets (one per duration)',
    TIMELINE_GROUP_ORDER.every(g => BUILTIN_TIMELINE_PRESETS.filter(p => p.group === g).length === 4));
}

console.log('cardio-timelines.js — buildTimelineWorkout()');
{
  const preset = BUILTIN_TIMELINE_PRESETS[0];
  const a = buildTimelineWorkout(preset);
  const b = buildTimelineWorkout(preset);
  check('returns a WorkoutModel with the preset\u2019s name', a.name === preset.label);
  check('an explicit name overrides the preset label', buildTimelineWorkout(preset, { name: 'My Ride' }).name === 'My Ride');
  check('building the same preset twice gives independent step ids', a.steps[0].id !== b.steps[0].id);
  check('building the same preset twice gives independent interval sub-step ids',
    a.steps[1].onStep.id !== b.steps[1].onStep.id && a.steps[1].offStep.id !== b.steps[1].offStep.id);
  check('same preset built twice still has identical target values', a.steps[0].targetLow === b.steps[0].targetLow && a.steps[0].targetHigh === b.steps[0].targetHigh);
  check('handles a preset with no steps without throwing', buildTimelineWorkout({ label: 'Empty' }).steps.length === 0);
}

console.log('cardio-timelines.js — createCustomTimelinePreset() / allTimelinePresets() / timelinePresetById()');
{
  check('every builtin preset is findable by id', BUILTIN_TIMELINE_PRESETS.every(p => timelinePresetById(p.id)?.id === p.id));
  check('an unknown id resolves to null', timelinePresetById('not-a-real-id') === null);
  check('allTimelinePresets() includes every builtin preset when no custom ones are loaded',
    BUILTIN_TIMELINE_PRESETS.every(p => allTimelinePresets().some(q => q.id === p.id)));

  const custom = createCustomTimelinePreset({ label: 'My 25-Minute Mix', durationMin: 25, basePresetId: BUILTIN_TIMELINE_PRESETS[0].id });
  check('custom preset id is prefixed custom:', custom.id.startsWith('custom:'));
  check('custom preset is flagged custom: true', custom.custom === true);
  check('custom preset carries the fields it was given', custom.label === 'My 25-Minute Mix' && custom.durationMin === 25);
  check('custom preset remembers which preset it started from', custom.basePresetId === BUILTIN_TIMELINE_PRESETS[0].id);
  check('two custom presets created back to back still get distinct ids',
    createCustomTimelinePreset().id !== createCustomTimelinePreset().id);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
