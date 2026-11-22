// Where one stereo sample goes in a device's frame of `channels` channels (already zeroed).
// `pair`: 0 = channels 1-2, 1 = 3-4, ... `mono`: 0 = stereo on that pair; N >= 1 = left and
// right mixed onto channel N alone (one feed per connector of a multi-output interface, for a
// DSP's mono inputs). A place the device doesn't have stays silent.
#pragma once

namespace mosaic {

inline void placeAudioFrame(float* frame, int channels, int pair, int mono, float left, float right) {
    if (mono > 0) {
        if (mono <= channels) frame[mono - 1] = 0.5f * (left + right);
    } else if (pair * 2 + 1 < channels) {
        frame[pair * 2] = left;
        frame[pair * 2 + 1] = right;
    } else if (channels == 1) {
        frame[0] = 0.5f * (left + right);
    }
}

}  // namespace mosaic
