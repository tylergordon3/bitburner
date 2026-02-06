import { exec, assert, is_empty_string, has_program } from  "../lib/util.js";
import { log } from "../lib/io.js";
import { all_programs } from "../lib/constants/tor.js";
import { study } from "../lib/singularity/study.js";

/**
 * @param {NS} ns
 */
async function bootstrap(ns) {
    if (ns.getServer("home").maxRam < 128) {
        const script = [];
        for (const s of script) {
            assert(!ns.isRunning(s, "home"));
            exec(ns, s);
            await ns.sleep(5e3);
            ns.kill(s, "home");
        }
    }
}

/**
 * @param {NS} ns
 * @param {string} program Name of program
 */
async function create_program(ns, program) {
    assert(is_valid_program(program));
    if (has_program(ns, program)) {
        return;
    }

    const threshold = hack_requirement(program);
    assert(threshold > 0);
    assert(ns.getHackingLevel() >= threshold);

    assert(ns.singularity.createProgram(program, true));
    while (ns.singularity.isBusy()) {
        assert(!has_program(ns, program));
        await ns.sleep(5e3);
    }
    assert(has_program(ns, program));
}

/**
 * @param {string} name
 * @returns {boolean} True if given name valid; 
 * false otherwise. 
 */
function is_valid_program(name) {
    assert(!is_empty_string(name));
    const program = all_programs();
    return program.has(name);
}

/**
 * @param {string} program
 * @returns {number} Hack stat
 */
function hack_requirement(program) {
    const prog = all_programs();
    return prog.get(program);
}

/**
 * @param {NS} ns
 */
async function study_and_create(ns) {
    const program = ["BruteSSH.exe", "FTPCrack.exe"];
    for (const p of program) {
        log(ns, `Raise Hack to create program ${p}`);
        await study(ns, hack_requirement(p));
        await bootstrap(ns);
        log(ns, `Create program ${p}`);
        await create_program(ns, p);
        await bootstrap(ns);
    }
}

/**
 * @param {NS} ns
 */
export async function main(ns) {
    // Make the log less verbose.
    ns.disableLog("getHackingLevel");
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("sleep");

    await study_and_create(ns);

    // exec(ns, MONEY)
}