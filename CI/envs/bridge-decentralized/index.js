require('module-alias/register');
const fs = require('fs');
const path = require('path');
const { 
    extractSolcVersion, 
    compileWithVersion, 
    deployContract 
} = require('@lib/web3/deploy');
const Mutex = require('async-mutex').Mutex;
const Semaphore = require('async-mutex').Semaphore;
const withTimeout = require('async-mutex').withTimeout;

const projectRoot = path.resolve(__dirname, '..', '..', '..'); 
const contractsDir = path.join(projectRoot, 'contracts', 'src', 'cross-chain');
const { sleep } = require('@lib/os/process');


let tokenSource = fs.readFileSync(path.join(contractsDir, 'CrossToken.sol'), 'utf8');
const mutex = new Mutex();
let lag;



const blockchains = new Map();
/* const assetDollarValue = new Map([
    ["ETH", 0.5],
    ["AVAX", 0.2]
]); */

/**
 * Deploys router, vault and token bridge contracts on the specified 
 * blockchain and initializes an event listener for these contracts to relay
 * transactions between the contracts.
 * 
 * @param {Object} web3 - The Web3 instance for the blockchain.
 * @param {Object} envInfo - An object containing environment information such as accounts, privateKeys, and rpcAddress for the blockchain.
 * @param {string} name - A string containing the name of the blockchain
 * @param {string} nativeToken - A string containing the name of the native cryptocurrency of the chain, ex: ETH for ethereum, AVAX for avalanche
 * @returns {Object} An object containing the sourceContract, tokenCrontract and destinationContract instances.
 * @throws {Error} If there's an error during the deployment.
 */
async function deployBridge(web3, envInfo, name, nativeToken, router, vault, oracle, bridgeForwards, bridgeForwardsERC20, bridgeDelay = 0){
    lag = bridgeDelay;
    let routerSource = fs.readFileSync(path.join(contractsDir, router+'.sol'), 'utf8');
    let vaultSource = fs.readFileSync(path.join(contractsDir, vault+'.sol'), 'utf8');
    let oracleSource = fs.readFileSync(path.join(contractsDir, oracle+'.sol'), 'utf8');


    //Deploy tokens
    let tokenSolcVersion = extractSolcVersion(tokenSource);
    let compiledToken = await compileWithVersion(tokenSource, 'CrossToken', 'CrossToken', tokenSolcVersion);
    let tokenParameters = [];
    let tokenContract = await deployContract(web3, compiledToken.abi, compiledToken.bytecode, envInfo, tokenParameters);

    let oracleSolcVersion = extractSolcVersion(oracleSource);
    let compiledOracle = await compileWithVersion(oracleSource, 'Oracle', 'Oracle', oracleSolcVersion);
    let oracleParameters = [name+'.'+nativeToken];
    let oracleContract = await deployContract(web3, compiledOracle.abi, compiledOracle.bytecode, envInfo, oracleParameters);

    //Deploy Router contracts
    let routerSolcVersion = extractSolcVersion(routerSource);
    let compiledRouter = await compileWithVersion(routerSource, router, router, routerSolcVersion);
    let routerParameters = [tokenContract._address];
    let routerContract = await deployContract(web3, compiledRouter.abi, compiledRouter.bytecode, envInfo, routerParameters);

    //Deploy vault contracts
    let vaultSolcVersion = extractSolcVersion(vaultSource);
    let compiledVault = await compileWithVersion(vaultSource, vault, vault, vaultSolcVersion);
    let vaultParameters = [routerContract._address, oracleContract._address];
    let vaultContract = await deployContract(web3, compiledVault.abi, compiledVault.bytecode, envInfo, vaultParameters);

    blockchains.set(name, {
        name: name,
        web3: web3,
        nativeToken: nativeToken,
        envInfo: envInfo,
        vault: vaultContract,
        signer: web3.eth.accounts.wallet[0].address,
        bridgeForwards: vaultContract.methods[bridgeForwards],
        bridgeForwardsERC20: vaultContract.methods[bridgeForwardsERC20]
    });

    /* //Giving ownership of minting and burning to destination chain contract
    let receipt0 = await tokenContract.methods.changeOwner(destinationContract._address).send({
        from: web3B.eth.accounts.wallet[0].address,
        gas: 300000,
    });
    if (!receipt0.status){
        throw new Error("Could not give ownership of token to destination contract");
    } */

    //Add event listeners to relay transactions
    routerContract.events.allEvents().on('data', (data) => {
        handleEvent(data, name);
        
    });

    return {
        token: tokenContract,
        router: routerContract,
        vault: vaultContract,
        oracle: oracleContract
    };
}

/**
 * Parses a memo string emitted by an event.
 * 
 * @param {string} memo - A string containing the memo of an event, example: SWAP:ETH.ETH:0x21312...
 * @returns {Object} An object containing the operation, chain and destination address and asset address the event regards.
 * @throws {Error} If there's an error during parsing.
 */
function parseMemo(memo){
    let array = memo.split(':');
    let operation = array[0];
    let assetName = array[1];
    let temp = array[1].split('.');
    let chain = temp[0];
    let asset = temp[1];
    let destaddr = array[2];

    return {
        operation: operation,
        chain: chain,
        asset: asset,
        assetName: assetName,
        destaddr: destaddr
    }
}

/**
 * Handles an event emitted on a relay contract.
 * 
 * @param {Object} data - An object containing the returnValues of an emitted blockchain event.
 * @param {string} name - The name of the blockchain that emitted the event
 * @throws {Error} If there's an error during relaying.
 */
async function handleEvent(data, name){
    console.log("Event on chain: " + name);
    switch(data.event) {
        case "Deposit":
            console.log("Deposit: " + data.returnValues.memo);
            await deposit(data, name);
            break;
        case "PayOut":  //no handling necessary, payout has happened
            console.log("PayOut: " + JSON.stringify(data.returnValues));
            break;
        default:
            console.log("Unexpected Event");
    }
}

//Handles all calls of the deposit function of the router contract, currently supports swap and add.
async function deposit(data, name){

        let memo = parseMemo(data.returnValues.memo);
        let target = blockchains.get(memo.chain);
        const release = await mutex.acquire();
        //await sleep(12000);
        try {
            if(target){ //If blockchain exists
                switch(memo.operation){
                    case "=":
                    case "SWAP":
                        //console.log(nonce);
                        //If 0x0 token, represent it as the name of the native token, eg. ETH or AVAX
                        let sourceAsset = data.returnValues.asset == "0x0000000000000000000000000000000000000000" ? name + '.' + blockchains.get(name).nativeToken : name + '.' + data.returnValues.asset;
                        //If native token, represent as 0x0
                        let targetToken = memo.asset == target.nativeToken ? "0x0000000000000000000000000000000000000000" : memo.asset;
                        //let amount = getExchange(sourceAsset, memo.asset, data.returnValues.amount);
                        let receipt;
                        let expiry = Math.floor(Date.now() / 1000) + 10;
                        if(lag !=0){
                            await sleep(lag);
                        }
                        if (targetToken == "0x0000000000000000000000000000000000000000"){
                            receipt = await target.bridgeForwards(memo.destaddr, targetToken, data.returnValues.amount, sourceAsset, "OUT:" + memo.destaddr, expiry).send({
                                from: target.signer,
                                gas: 300000,
                            });
                        }
                        else{
                            receipt = await target.bridgeForwardsERC20(memo.destaddr, targetToken, data.returnValues.amount, sourceAsset, memo.assetName, "OUT:" + memo.destaddr, expiry).send({
                                from: target.signer,
                                gas: 300000,
                            });
                        }
                        if(receipt.status){
                            return;
                        }
                        break;
                    case "ADD": //Liquidity was added to the vault, no relaying necessary
                        return;
                    default:
                        break;
                }
            }
        } catch (error) {
            console.log(error);
            console.log("Could not relay transaction");
            //If above section did not return, refund the transaction, could implement some kind of fee to stop spamming
            /* console.log("Issuing refund");
            target = blockchains.get(name);
            let receipt = await target.vault.methods.bridgeForwards(data.returnValues.from, data.returnValues.asset, data.returnValues.amount, "REFUND:" + data.returnValues.from).send({
                from: target.signer,
                gas: 300000,
            }); */
        } finally {
            release();
        }

    
}

module.exports = deployBridge;