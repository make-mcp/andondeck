/**
 * The bundled profile for each Stream Deck device type, by the name the
 * manifest lists it under. A test holds this to the manifest, so a profile
 * added to one cannot be forgotten in the other.
 */
export const PROFILE_FOR_DEVICE: Record<number, string> = {
	0: "Andon Deck",
	1: "Andon Deck Mini",
	2: "Andon Deck XL",
	3: "Andon Deck Mobile",
	5: "Andon Deck Pedal",
	7: "Andon Deck Plus",
	9: "Andon Deck Neo",
	10: "Andon Deck Studio",
	11: "Andon Deck Virtual",
	12: "Andon Deck Galleon",
	13: "Andon Deck Plus XL",
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
