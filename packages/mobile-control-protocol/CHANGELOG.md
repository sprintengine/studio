# Changelog

## 2.0.0

First published version. The module is unchanged — it is the file both
repositories were already maintaining as byte-identical copies, extracted
verbatim so the sha256 pin that guards the phone's remaining copy still holds
while the phone's build works its way through store review.

The version is `2.0.0` rather than `0.1.0` or `1.0.0` because the npm major
tracks `mobileControlProtocolVersion`, which is `2`. See the README.

Contents: the mobile-control command, event and snapshot types, the runtime
validators (`validateMobileControlCommand`, `…Event`, `…Snapshot`, `…Device`,
`…Capabilities`, `…Error`), the protocol version window
(`mobileControlSupportedProtocolVersions`,
`isSupportedMobileControlProtocolVersion`,
`unsupportedMobileControlProtocolVersion`) and the payload size and count
ceilings the relay budget depends on.
