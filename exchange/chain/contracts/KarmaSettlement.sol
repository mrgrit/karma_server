// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// Custodial LAN token. All transfers are signed and settled through the hub.
/// Direct wallet transfer/allowance paths cannot bypass the exchange's accounting.
contract DepartmentToken is ERC20 {
    address public immutable settlement;
    uint8 private immutable unitDecimals;
    uint256 public immutable supplyCap;
    constructor(string memory n, string memory s, uint8 d, uint256 cap) ERC20(n, s) {
        settlement = msg.sender; unitDecimals = d; supplyCap = cap;
    }
    function decimals() public view override returns (uint8) { return unitDecimals; }
    function settle(address from, address to, uint256 amount) external {
        require(msg.sender == settlement, "SETTLEMENT_ONLY");
        require(to != address(0) && from != to && amount > 0, "INVALID_MOVE");
        if (from == address(0)) { require(totalSupply() + amount <= supplyCap, "SUPPLY_CAP"); _mint(to, amount); }
        else { _transfer(from, to, amount); }
        require(balanceOf(to) <= 1e12, "WALLET_LIMIT");
    }
    function _update(address from, address to, uint256 amount) internal override {
        require(msg.sender == settlement, "CUSTODIAL_TOKEN");
        super._update(from, to, amount);
    }
}

/// Atomic coin creation and settlement for transfers, matching, fees and refunds.
/// Operators can transact; the separate offline owner can rotate the operator.
contract KarmaSettlement is Ownable2Step {
    struct Asset { string symbol; string name; uint8 decimals; uint256 cap; }
    struct Move { bytes32 asset; address from; address to; uint256 amount; }
    mapping(bytes32 => address) public tokens;
    mapping(bytes32 => bytes32) public batchDigests;
    mapping(bytes32 => uint256) public batchBlocks;
    address public operator;
    uint256 public sequence;
    bool public paused;
    event AssetCreated(bytes32 indexed asset, address indexed token, string symbol, uint8 decimals, uint256 cap);
    event Settled(bytes32 indexed batch, uint256 indexed sequence, bytes32 digest, bytes32 auditDigest);
    event OperatorChanged(address indexed operator);
    constructor(address owner_, address operator_) Ownable(owner_) {
        require(operator_ != address(0), "ZERO_OPERATOR"); operator = operator_;
    }
    function setOperator(address value) external onlyOwner { require(value != address(0), "ZERO_OPERATOR"); operator = value; emit OperatorChanged(value); }
    function setPaused(bool value) external onlyOwner { paused = value; }
    function settle(bytes32 batch, uint256 expectedSequence, Asset[] calldata assets, Move[] calldata moves, bytes32 auditDigest) external {
        require(msg.sender == operator && !paused, "OPERATOR_REQUIRED");
        bytes32 digest = keccak256(abi.encode(expectedSequence, assets, moves, auditDigest));
        if (batchBlocks[batch] != 0) { require(batchDigests[batch] == digest, "BATCH_CONFLICT"); return; }
        require(expectedSequence == sequence, "SEQUENCE_CONFLICT");
        require(moves.length > 0 && moves.length <= 1024 && assets.length <= 32, "BATCH_SIZE");
        for (uint256 i; i < assets.length; ++i) {
            Asset calldata a = assets[i]; bytes32 id = keccak256(bytes(a.symbol));
            require(tokens[id] == address(0) && bytes(a.symbol).length > 0 && bytes(a.symbol).length <= 10, "ASSET_EXISTS");
            require(a.decimals <= 2 && a.cap > 0 && a.cap <= 1e18, "ASSET_POLICY");
            DepartmentToken token = new DepartmentToken(a.name, a.symbol, a.decimals, a.cap);
            tokens[id] = address(token); emit AssetCreated(id, address(token), a.symbol, a.decimals, a.cap);
        }
        for (uint256 i; i < moves.length; ++i) {
            Move calldata m = moves[i]; address token = tokens[m.asset];
            require(token != address(0), "UNKNOWN_ASSET");
            DepartmentToken(token).settle(m.from, m.to, m.amount);
        }
        sequence += 1; batchDigests[batch] = digest; batchBlocks[batch] = block.number;
        emit Settled(batch, sequence, digest, auditDigest);
    }
}
