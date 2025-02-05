pragma solidity ^0.8.20;

interface EthRouter {
    function eth_payOut(
        address payable to,
        address asset,
        uint amount,
        string memory memo
    ) external payable;
}

contract EthVault {
    address owner;
    EthRouter routerContract;

    constructor(address _routerContract) {
        owner = msg.sender;
        routerContract = EthRouter(_routerContract);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner of this contract can call this function");
        _;
    }

    //Receive funds when msg.data is empty
    receive() external payable {}

    //Receive funds when msg.data is not empty
    fallback() external payable {}

    function fund() external payable {}

    function eth_bridgeForwards(
        address payable to,
        address asset,
        uint amount,
        string memory memo
    ) external onlyOwner {
        require(
                address(this).balance >= amount,
                "Vault has insufficient funds"
            );
            routerContract.eth_payOut{value: amount}(
                to,
                asset,
                amount,
                memo
            );
    }

    function eth_bridgeForwardsERC20(
        address payable to,
        address asset,
        uint amount,
        string memory memo
    ) external onlyOwner {
        routerContract.eth_payOut(to, asset, amount, memo);
    }
}
