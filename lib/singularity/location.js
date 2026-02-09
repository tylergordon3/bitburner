const UNIVERSITY_LOCATIONS = new Set([
    "Rothman University",
    "Summit University",
    "ZB Institute of Technology",
    "Aevum University",
]);

/**
 * @param {string} location
 * @returns {string | undefined}
 */
export function toUniversityLocation(location) {
    return UNIVERSITY_LOCATIONS.has(location) ? location : undefined;
}
