
/** @param {NS} ns */
export async function main(ns) {

    const company = "Carmichael Security";

    ns.singularity.applyToCompany(company, "Software");
    ns.singularity.workForCompany(company, true);
    
}
