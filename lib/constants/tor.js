export function all_programs() {
    // Map - Name : Hack stat
    const program  = new Map([
        ["BruteSSH.exe", 50],
        ["FTPCrack.exe", 100],
        ["HTTPWorm.exe", 500],
        ["relaySMTP.exe", 250],
        ["SQLInject.exe", 750],
        ["DeepscanV1.exe", 75],
        ["DeepscanV2.exe", 400],
        ["ServerProfiler.exe", 75],
        ["AutoLink.exe", 25],
        ["Formulas.exe", 1000],
    ]);
    return program
}

export const darkweb = {
    program: {
        brutessh: {
            COST: 500e3,
            NAME: "BurthSSH.exe",
            HACK: 50,
        },
        ftpcrack: {
            COST: 1.5e6,
            NAME: "FTPCrack.exe",
            HACK: 100,
        },
        httpworm: {
            COST: 30e6,
            NAME: "HTTPWorm.exe",
            HACK: 500,
        },
        relaysmtp: {
            COST: 5e6,
            NAME: "relaySMTP.exe",
            HACK: 250,
        },
        sqlinject: {
            COST: 250e6,
            NAME: "SQLInject.exe",
            HACK: 750,
        },
    },
    tor: {
        COST: 200e3,
    },
};