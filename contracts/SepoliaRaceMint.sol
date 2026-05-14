// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SepoliaRaceMint {
    string public constant name = "Sepolia Race Mint";
    string public constant symbol = "SRM";

    uint256 public immutable priceWei;
    uint256 public immutable maxSupply;
    address public immutable owner;

    uint256 public mintOpensAt;
    uint256 public totalSupply;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event MintWindowUpdated(uint256 mintOpensAt);

    error NotOwner();
    error MintClosed();
    error InvalidQuantity();
    error SupplyExceeded();
    error WrongValue();
    error NotMinted();

    constructor(uint256 _priceWei, uint256 _maxSupply, uint256 _mintOpensAt) {
        owner = msg.sender;
        priceWei = _priceWei;
        maxSupply = _maxSupply;
        mintOpensAt = _mintOpensAt;
    }

    function setMintOpensAt(uint256 _mintOpensAt) external {
        if (msg.sender != owner) revert NotOwner();
        mintOpensAt = _mintOpensAt;
        emit MintWindowUpdated(_mintOpensAt);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address tokenOwner = _ownerOf[tokenId];
        if (tokenOwner == address(0)) revert NotMinted();
        return tokenOwner;
    }

    function mint(uint256 quantity) external payable returns (uint256 firstTokenId) {
        if (block.timestamp < mintOpensAt) revert MintClosed();
        if (quantity == 0 || quantity > 5) revert InvalidQuantity();
        if (totalSupply + quantity > maxSupply) revert SupplyExceeded();
        if (msg.value != quantity * priceWei) revert WrongValue();

        firstTokenId = totalSupply + 1;

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = totalSupply + 1;
            totalSupply = tokenId;
            _ownerOf[tokenId] = msg.sender;
            balanceOf[msg.sender] += 1;
            emit Transfer(address(0), msg.sender, tokenId);
        }
    }
}
