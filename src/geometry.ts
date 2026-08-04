/* Baked-knob geometry, measured off the photoreal renders in the desktop
 * suite (the_guitar_guy/src/ui/ModulePanels.cpp) — nx/ny are fractions of the
 * face image's width/height, nr is the knob radius as a fraction of width.
 * The live sprite is drawn ~5% larger than its baked twin so it covers it. */

export interface KnobGeo { nx: number; ny: number; nr: number; param: string }
export interface FaceDef {
  img: string;            // /assets/ui/…
  aspect: number;         // w / h of the render
  sprite: string;         // knob sprite image
  knobs: KnobGeo[];
}

const A = (param: string, nx: number, ny: number, nr: number): KnobGeo => ({ param, nx, ny, nr });

export const AMP_FACES: Record<string, FaceDef & { voices: { label: string; stem: string }[]; name: string }> = {
  camden: {
    name: 'Camden',
    img: '/assets/ui/amp_face_ac30.png', aspect: 1644 / 765,
    sprite: '/assets/ui/knob_amp_ac30.png',
    knobs: [
      A('amp_gain', 0.2056, 0.8013, 0.03), A('amp_bass', 0.3229, 0.8013, 0.03),
      A('amp_mid', 0.4402, 0.8013, 0.03), A('amp_treble', 0.5574, 0.8013, 0.03),
      A('amp_cut', 0.6747, 0.8013, 0.03), A('amp_master', 0.792, 0.8013, 0.03),
      A('amp_output', 0.9093, 0.8013, 0.03),
    ],
    voices: [
      { label: 'CLEAN', stem: 'camden_clean' },
      { label: 'DRIVEN', stem: 'camden_driven' },
      { label: 'MAX', stem: 'camden_max' },
    ],
  },
  portland: {
    name: 'Portland',
    img: '/assets/ui/amp_face_plexi.png', aspect: 1750 / 848,
    sprite: '/assets/ui/knob_amp_plexi.png',
    knobs: [
      A('amp_gain', 0.2194, 0.745, 0.0246), A('amp_bass', 0.3263, 0.745, 0.0246),
      A('amp_mid', 0.4382, 0.745, 0.0246), A('amp_treble', 0.5497, 0.745, 0.0246),
      A('amp_cut', 0.6596, 0.745, 0.0246), A('amp_master', 0.7703, 0.745, 0.0246),
      A('amp_output', 0.8762, 0.745, 0.0246),
    ],
    voices: [
      { label: 'BLOOM', stem: 'portland_bloom' },
      { label: 'LEAD', stem: 'portland_lead' },
    ],
  },
  katahdin: {
    name: 'Katahdin',
    img: '/assets/ui/amp_face_heavy.png', aspect: 1666 / 875,
    sprite: '/assets/ui/knob_amp_heavy.png',
    knobs: [
      A('amp_gain', 0.2074, 0.7989, 0.029), A('amp_bass', 0.3217, 0.7989, 0.029),
      A('amp_mid', 0.4361, 0.7989, 0.029), A('amp_treble', 0.5504, 0.7989, 0.029),
      A('amp_cut', 0.6648, 0.7989, 0.029), A('amp_master', 0.7792, 0.7989, 0.029),
      A('amp_output', 0.8935, 0.7989, 0.029),
    ],
    voices: [
      { label: 'BLUE', stem: 'katahdin_blue' },
      { label: 'RED', stem: 'katahdin_red' },
    ],
  },
};

export const PEDAL_FACES: Record<string, FaceDef> = {
  gate: {
    img: '/assets/ui/pedal_gate.png', aspect: 1774 / 887,
    sprite: '/assets/ui/knob_fx_gate.png',
    knobs: [
      A('gate_thresh', 0.35555, 0.23816, 0.0465),
      A('gate_release', 0.49662, 0.23873, 0.0465),
      A('gate_range', 0.63653, 0.23837, 0.0465),
    ],
  },
  comp: {
    img: '/assets/ui/pedal_comp.png', aspect: 1774 / 887,
    sprite: '/assets/ui/knob_fx_comp.png',
    knobs: [
      A('comp_sustain', 0.3613, 0.272, 0.0423),
      A('comp_attack', 0.4996, 0.272, 0.0423),
      A('comp_level', 0.6385, 0.2723, 0.0423),
    ],
  },
  drive: {
    img: '/assets/ui/pedal_drive.png', aspect: 1774 / 887,
    sprite: '/assets/ui/knob_fx_drive.png',
    knobs: [
      A('drive_gain', 0.3405, 0.2943, 0.0383),
      A('drive_tone', 0.4465, 0.2943, 0.0383),
      A('drive_level', 0.5581, 0.2943, 0.0383),
      A('drive_air', 0.6646, 0.2943, 0.0383),
    ],
  },
  chorus: {
    img: '/assets/ui/pedal_chorus.png', aspect: 1772 / 887,
    sprite: '/assets/ui/knob_fx_chorus.png',
    knobs: [
      A('cho_rate', 0.2725, 0.3081, 0.0502),
      A('cho_depth', 0.4194, 0.3087, 0.0502),
      A('cho_tone', 0.5777, 0.308, 0.0502),
      A('cho_mix', 0.7238, 0.3083, 0.0502),
    ],
  },
  reverb: {
    img: '/assets/ui/pedal_sky.png', aspect: 1770 / 888,
    sprite: '/assets/ui/knob_fx_reverb.png',
    knobs: [
      A('rvb_decay', 0.3452, 0.277, 0.041),
      A('rvb_predelay', 0.5, 0.277, 0.041),
      A('rvb_mix', 0.6537, 0.277, 0.041),
      A('rvb_tone', 0.3452, 0.536, 0.041),
      A('rvb_mod', 0.4989, 0.535, 0.041),
      A('rvb_shimmer', 0.6537, 0.5372, 0.041),
      A('rvb_hp', 0.2531, 0.6948, 0.024),
      A('rvb_lp', 0.7458, 0.6948, 0.024),
    ],
  },
  sauce: {
    img: '/assets/ui/pedal_sauce.png', aspect: 1771 / 888,
    sprite: '/assets/ui/knob_fx_sauce.png',
    knobs: [
      A('sauce_body', 0.2451, 0.5743, 0.033),
      A('sauce_sub', 0.3715, 0.5743, 0.033),
      A('sauce_tight', 0.4975, 0.5743, 0.033),
      A('sauce_tame', 0.6245, 0.5777, 0.033),
      A('sauce_smooth', 0.7549, 0.5856, 0.033),
      A('sauce_punch', 0.2451, 0.8018, 0.033),
      A('sauce_pres', 0.3715, 0.8018, 0.033),
      A('sauce_air', 0.6245, 0.8052, 0.033),
      A('sauce_mix', 0.7549, 0.8232, 0.033),
    ],
  },
};

export function delayFace(engineIdx: 0 | 1): FaceDef {
  const p = engineIdx === 0 ? 'dlyA_' : 'dlyB_';
  const g = engineIdx === 0
    ? [
        [0.3422, 0.2849, 0.0395], [0.4997, 0.286, 0.0395], [0.6578, 0.2849, 0.0395],
        [0.3422, 0.5372, 0.0395], [0.4986, 0.5383, 0.0395], [0.6578, 0.5372, 0.0395],
        [0.2473, 0.6835, 0.0192], [0.7482, 0.6813, 0.0192],
      ]
    : [
        [0.3418, 0.2778, 0.0395], [0.5, 0.2778, 0.0395], [0.6576, 0.2767, 0.0395],
        [0.342, 0.5264, 0.0395], [0.5, 0.5264, 0.0395], [0.6571, 0.5264, 0.0395],
        [0.2486, 0.6704, 0.0224], [0.75, 0.6749, 0.0224],
      ];
  // Well order on the print: TIME FEEDBACK MIX / MOD GRIT TONE, then the
  // HI-PASS / LO-PASS wet trims flanking the name plate.
  const order = ['time', 'fb', 'mix', 'mod_depth', 'grit', 'hicut', 'wet_hp', 'wet_lp'];
  return {
    img: engineIdx === 0 ? '/assets/ui/pedal_delay.png' : '/assets/ui/pedal_delay_b.png',
    aspect: engineIdx === 0 ? 1771 / 888 : 1770 / 889,
    sprite: '/assets/ui/knob_fx_delay.png',
    knobs: order.map((id, k) => A(p + id, g[k][0], g[k][1], g[k][2])),
  };
}

// Studio strip — coordinates in the plugin's 1224×600 face space.
const S = (param: string, cx: number, cy: number, r: number, sprite: string) => ({
  param, nx: cx / 1224, ny: cy / 600, nr: r / 1224, sprite,
});
export const STUDIO_FACE = {
  img: '/assets/ui/studio_face.png', aspect: 1755 / 896,
  knobs: [
    S('eq_hpf', 136.0, 219.2, 34.3, '/assets/ui/knob_fx_studio_filter.png'),
    S('eq_lf_f', 335.1, 268.6, 27.7, '/assets/ui/knob_fx_studio_blue.png'),
    S('eq_lf_g', 337.1, 164.4, 27.7, '/assets/ui/knob_fx_studio_gain.png'),
    S('eq_lmf_f', 529.3, 268.6, 27.7, '/assets/ui/knob_fx_studio_blue.png'),
    S('eq_lmf_g', 529.9, 164.3, 27.7, '/assets/ui/knob_fx_studio_gain.png'),
    S('eq_hmf_f', 719.2, 268.5, 27.7, '/assets/ui/knob_fx_studio_green.png'),
    S('eq_hmf_g', 719.5, 164.3, 27.7, '/assets/ui/knob_fx_studio_gain.png'),
    S('eq_hf_f', 903.2, 268.4, 27.7, '/assets/ui/knob_fx_studio_red.png'),
    S('eq_hf_g', 903.8, 164.3, 27.7, '/assets/ui/knob_fx_studio_gain.png'),
    S('eq_trim', 1085.5, 206.5, 29.9, '/assets/ui/knob_fx_studio_out.png'),
    S('fet_input', 108.1, 486.1, 40.8, '/assets/ui/knob_fx_studio_comp.png'),
    S('fet_output', 239.8, 486.0, 40.8, '/assets/ui/knob_fx_studio_comp.png'),
    S('fet_attack', 369.8, 486.0, 40.8, '/assets/ui/knob_fx_studio_comp.png'),
    S('fet_release', 497.0, 486.0, 40.8, '/assets/ui/knob_fx_studio_comp.png'),
    S('fet_mix', 623.5, 486.0, 40.8, '/assets/ui/knob_fx_studio_comp.png'),
  ],
};
