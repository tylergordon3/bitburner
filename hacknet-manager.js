/** @param {NS} ns */
export async function main(ns) {
    const reserve = 1000000; // 1,000,000 Million
    const nodesTargetCount = 12;
    const nodesTargetLevel = 200;
    const nodesTargetRAM = 32;
    const nodesTargetCores = 8;
 
    ns.disableLog('ALL');
    
    function getMoney() {
        return ns.getServerMoneyAvailable('home') - reserve;
    }
 
    function sortPurchase(a, b) {
        return a.cost - b.cost;
    }
 
    while (true) {
        await ns.sleep(1000);
 
        var nodes = ns.hacknet.numNodes();
        var purchase = [];
 
        if (nodes < nodesTargetCount) {
            purchase.push({
                id: null,
                cost: ns.hacknet.getPurchaseNodeCost(),
                type: 'new',
            });
        }
 
        for (let n = 0; n < nodes; n += 1) {
            let nodeStats = ns.hacknet.getNodeStats(n);
            let existingNode = {
                id: n,
                level: nodeStats.level,
                ram: nodeStats.ram,
                cores: nodeStats.cores,
            }
 
            if (existingNode.level < nodesTargetLevel) {
                purchase.push({
                    id: existingNode.id,
                    cost: ns.hacknet.getLevelUpgradeCost(existingNode.id, 1),
                    type: 'level',
                });
            }
 
            if (existingNode.ram < nodesTargetRAM) {
                purchase.push({
                    id: existingNode.id,
                    cost: ns.hacknet.getRamUpgradeCost(existingNode.id, 1),
                    type: 'ram',
                });
            }
 
            if (existingNode.cores < nodesTargetCores) {
                purchase.push({
                    id: existingNode.id,
                    cost: ns.hacknet.getCoreUpgradeCost(existingNode.id, 1),
                    type: 'cores',
                });
            }
        }
 
        // Sort by lowest price
        purchase.sort(sortPurchase);
 
        for (let p = 0; p < purchase.length; p += 1) {
            let current = purchase[p];
            // ns.print(`PID [${p}] Node (${current.id}) Purchase: ${current.type} @ ${current.cost}`);
            if (current.cost < getMoney()) {
                switch (current.type) {
                    case 'new': {
                        // Buy a new node
                        let ref = ns.hacknet.purchaseNode();
                        ns.print(`Bought a node [hacknet-node-${ref}]`);
                        break;
                    }
                    case 'level': {
                        // Buy a new level
                        ns.hacknet.upgradeLevel(current.id, 1);
                        ns.print(`Upgraded [hacknet-node-${current.id}] Level`);
                        break;
                    }
                    case 'ram': {
                        // Buy more ram
                        ns.hacknet.upgradeRam(current.id);
                        ns.print(`Upgraded [hacknet-node-${current.id}] RAM`);
                        break;
                    }
                    case 'cores': {
                        // Buy more cores
                        ns.hacknet.upgradeCore(current.id);
                        ns.print(`Upgraded [hacknet-node-${current.id}] Cores`);
                        break;
                    }
                    default: {
                        ns.print('Could not detect type of purchase');
                    }
                }
            }
        }
    }
    // ns.print(`Money: ${getMoney()}`);
}