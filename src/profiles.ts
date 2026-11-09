/**
 * The bundled profile for each Stream Deck device type, by the name the
 * manifest lists it under. A test holds this to the manifest, so a profile
 * added to one cannot be forgotten in the other.
 */
export const PROFILE_FOR_DEVICE: Record<number, string> = {
	0: "Claude Deck",
	1: "Claude Deck Mini",
	2: "Claude Deck XL",
	3: "Claude Deck Mobile",
	5: "Claude Deck Pedal",
	7: "Claude Deck Plus",
	9: "Claude Deck Neo",
	10: "Claude Deck Studio",
	11: "Claude Deck Virtual",
	12: "Claude Deck Galleon",
	13: "Claude Deck Plus XL",
};

/**
 * The full-deck alert profile for each device type. The Pedal has no screens
 * to show it on, so it has none.
 */
export const ALERT_PROFILE_FOR_DEVICE: Record<number, string> = Object.fromEntries(
	Object.entries(PROFILE_FOR_DEVICE)
		.filter(([type]) => Number(type) !== 5)
		.map(([type, name]) => [Number(type), `${name} Alert`]),
);
