type PairingPayload = {
    mobileControlProtocolVersion: 2;
    pairingChallengeId: string;
    relayUrl: string;
    pairingSecret: string;
    expiresAt: string;
    desktop: {
        displayName: string;
        desktopInstanceId: string;
        desktopRelaySessionId: string;
    };
};
type PairingChallengeLike = {
    manualPairingCode?: string;
    pairingUri: string;
    pairingPayload?: PairingPayload;
};
export declare function manualPairingValueFromRelayChallenge(challenge: PairingChallengeLike): string;
export {};
