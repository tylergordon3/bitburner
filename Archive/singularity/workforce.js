
/** @param {NS} ns */
export async function applyAndWork(ns) {

    const company = "Carmichael Security";

    ns.singularity.applyToCompany(company, "Software");
    // @ts-ignore
    ns.singularity.workForCompany(company, true);
    
}
