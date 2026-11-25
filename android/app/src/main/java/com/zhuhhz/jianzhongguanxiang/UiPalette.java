package com.zhuhhz.jianzhongguanxiang;

import android.content.Context;

/** Names and color values follow the existing Mini Program, not system dynamic colors. */
final class UiPalette {
    final String key, name;
    final int bg, text, muted, border, accent, control, onAccent, light, dark, errorBg, errorText;
    private UiPalette(Context context, String key, String name, int... ids) {
        this.key = key; this.name = name;
        int[] c = new int[ids.length];
        for (int i = 0; i < ids.length; i++) c[i] = context.getColor(ids[i]);
        bg=c[0]; text=c[1]; muted=c[2]; border=c[3]; accent=c[4]; control=c[5];
        onAccent=c[6]; light=c[7]; dark=c[8]; errorBg=c[9]; errorText=c[10];
    }
    static UiPalette get(Context c, String key) {
        switch (key) {
            case "paper": return new UiPalette(c, "paper", "宣纸", R.color.paper_bg, R.color.paper_text, R.color.paper_muted,
                R.color.paper_border, R.color.paper_accent, R.color.paper_control, R.color.paper_on_accent,
                R.color.paper_light, R.color.paper_dark, R.color.paper_error_bg, R.color.paper_error_text);
            case "night": return new UiPalette(c, "night", "夜墨", R.color.night_bg, R.color.night_text, R.color.night_muted,
                R.color.night_border, R.color.night_accent, R.color.night_control, R.color.night_on_accent,
                R.color.night_light, R.color.night_dark, R.color.night_error_bg, R.color.night_error_text);
            default: return new UiPalette(c, "ink", "青墨", R.color.ink_bg, R.color.ink_text, R.color.ink_muted,
                R.color.ink_border, R.color.ink_accent, R.color.ink_control, R.color.ink_on_accent,
                R.color.ink_light, R.color.ink_dark, R.color.ink_error_bg, R.color.ink_error_text);
        }
    }
}
