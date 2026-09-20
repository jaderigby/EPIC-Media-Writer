# Changelog

## 1.0.0

- Extract the existing WAV integrity implementation into the independent
  `audio-meta-armor` package.
- Expose WAV safety through `audio-meta-armor/wav` and the root `wav` namespace.
- Preserve the existing WAV verification and write behavior.
- Reserve future format support for separate APIs; MP3 is not yet supported.
