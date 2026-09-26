# Conversation protocol

The additive `conversations` lane on Studio's tailnet gateway. A socket is
scoped to one conversation and receives replay before `synchronized`, followed
by live events. Every mutation has a stable `commandId`; reads have a
`requestId`. This package contains portable frame types, input validation, tool
classification and presentation, without Electron, Node, or React dependencies.

Transcript frames travel directly over the tailnet, never through the hosted
relay. Hosted push-notification delivery is a separate integration.
