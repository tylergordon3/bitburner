import { cities } from "lib/constants/location.js";
import { assert, is_empty_string } from "../util";
import { course } from 'lib/constants/study.js';
import { empty_string } from "../constants/misc";
import { toUniversityLocation } from "./location";
import { LocationName, UniversityClassType, UniversityLocationName } from "../../NetscriptDefinitions";

/**
 * @param {NS} ns
 * @returns {LocationName}
 */
function choose_university(ns) {
    const { city } = ns.getPlayer();
    const { uni } = cities[city];
    return uni ?? empty_string;
}

/**
 * @param {NS} ns
 * @param {number} threshold
 */
export async function study(ns, threshold) {
    assert(threshold > 0);
    const uni = choose_university(ns);
    if (is_empty_string(uni)) {
        return;
    }

    ns.singularity.goToLocation(uni);
    assert(ns.singularity.universityCourse(toUniversityLocation(uni), UniversityClassType.computerScience, true));

    while (ns.getHackingLevel() < threshold) {
        await ns.sleep(5e3);
    }
    assert(ns.singularity.stopAction());
}