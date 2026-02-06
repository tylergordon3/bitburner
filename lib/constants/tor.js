

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