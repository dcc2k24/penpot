/**
 * Cause notes of the targets whose largest cluster of different pixels is above the real-mismatch size, keyed by
 * target id. Each note is a short text with its evidence: the diff PNG path and the cause. The notes come from the
 * analysis in PARITY-NOTES.md. A target without a note reports "no cause recorded".
 *
 * The screenshots are taken in the exporter container, so the remaining differences are small edge and antialiasing
 * differences, not layout differences. No target is over its pixel budget.
 */
export const PIXEL_CAUSES: Readonly<Record<string, string>> = {
    "Alert/Error":
        "Antialiasing at the rounded corners and the left accent-bar edge. The text matches. Inspected: out/compare/Alert-Error-diff.png",
    "Alert/Info":
        "Same as Alert/Error: corner and accent-bar edge antialiasing. Not inspected separately: out/compare/Alert-Info-diff.png",
    "Alert/Success":
        "Same as Alert/Error: corner and accent-bar edge antialiasing. Not inspected separately: out/compare/Alert-Success-diff.png",
    "Alert/Warning":
        "Same as Alert/Error: corner and accent-bar edge antialiasing. Not inspected separately: out/compare/Alert-Warning-diff.png",
    "onboarding/sign-up":
        "Small edge cluster under budget (0.01 percent). Not inspected one by one: out/compare/onboarding-sign-up-diff.png",
    "onboarding/done":
        "Small edge cluster under budget. Not inspected one by one: out/compare/onboarding-done-diff.png",
    "settings/profile":
        "Small edge cluster under budget. Not inspected one by one: out/compare/settings-profile-diff.png",
    "settings/billing":
        "Small edge cluster under budget. Not inspected one by one: out/compare/settings-billing-diff.png",
    "checkout/payment":
        "Small edge cluster under budget (0.01 percent). Not inspected one by one: out/compare/checkout-payment-diff.png",
    "checkout/confirmation":
        "Small edge cluster under budget (0.01 percent). Not inspected one by one: out/compare/checkout-confirmation-diff.png",
};

/**
 * Looks up the cause note of a target. Only the keys of PIXEL_CAUSES count, so an id such as "constructor" gives null.
 *
 * @param targetId - id of the target
 * @returns the cause note, or null when none is recorded
 */
export function causeOf(targetId: string): string | null {
    return Object.hasOwn(PIXEL_CAUSES, targetId) ? PIXEL_CAUSES[targetId] : null;
}
