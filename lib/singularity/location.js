import { LocationName, UniversityLocationName } from "../../NetscriptDefinitions";

/**
 * @param {string} location
 * @returns {UniversityLocationName | undefined}
 */
export function toUniversityLocation(location) {
    return Object.values(UniversityLocationName).includes(LocationName[location]) 
    ? UniversityLocationName[location] : undefined;
}