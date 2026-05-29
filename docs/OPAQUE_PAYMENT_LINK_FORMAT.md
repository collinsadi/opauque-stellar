# Opaque Payment Link Format Specification

## Overview

Opaque payment links are app-specific URIs that encode stealth payment requests with versioning, chain/network binding, and optional SEP (Stellar Ecosystem Proposal) compatibility. These links are designed to be opaque to standard Stellar wallets, ensuring they are only processed by Opaque-aware applications.

## Format Structure

```
opaque://v{version}/{network}/{meta-address}?{parameters}
```

### Components

#### Version (`v{version}`)
- **Format**: `v` followed by a numeric version identifier
- **Current version**: `v1`
- **Purpose**: Allows future protocol upgrades while maintaining backward compatibility
- **Encoding**: ASCII string

#### Network (`{network}`)
- **Format**: Network identifier string
- **Supported values**:
  - `testnet` - Stellar Testnet
  - `mainnet` - Stellar Mainnet
  - `futurenet` - Stellar Futurenet
  - `local` - Local development network
- **Purpose**: Binds the payment link to a specific Stellar network
- **Encoding**: ASCII string (lowercase)

#### Meta-address (`{meta-address}`)
- **Format**: Hex-encoded stealth meta-address (66 characters: `0x` + 64 hex chars)
- **Purpose**: Recipient's stealth meta-address for deriving one-time payment addresses
- **Encoding**: Hexadecimal string (lowercase)

#### Parameters (`?{parameters}`)
Optional query parameters for additional functionality:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `amount` | string | No | Requested amount in XLM (decimal, e.g., "10.5") |
| `asset` | string | No | Asset code for non-native assets (e.g., "USDC") |
| `issuer` | string | No | Asset issuer address (required if `asset` is specified) |
| `memo` | string | No | Optional memo text (URL-encoded) |
| `sep` | string | No | SEP protocol version for compatibility (e.g., "sep-31") |
| `callback` | string | No | Callback URL for payment status updates |
| `label` | string | No | Human-readable label for the payment request |
| `expires` | string | No | ISO 8601 timestamp for link expiration |

## Examples

### Basic payment link
```
opaque://v1/testnet/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

### Payment link with amount
```
opaque://v1/mainnet/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef?amount=50.0
```

### Payment link with custom asset
```
opaque://v1/testnet/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef?asset=USDC&issuer=GD5J6HF7ZDQ7LZK7YJYNKFSXSBQHQZIVJLH7NQX7X7X7X7X7X7X7X7X
```

### Payment link with SEP-31 compatibility
```
opaque://v1/mainnet/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef?sep=sep-31&amount=100.0&callback=https://example.com/callback
```

### Payment link with expiration
```
opaque://v1/testnet/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef?amount=25.0&expires=2026-12-31T23:59:59Z
```

## Versioning Rules

### Version 1 (v1)
- Initial release
- Supports all parameters listed above
- Network binding required
- Meta-address format: 66-character hex string

### Future Versions
- Must maintain backward compatibility with v1 parsing
- May add new parameters
- May change encoding schemes for specific components
- Version bump required for breaking changes

## Chain/Network Binding

Payment links are bound to specific Stellar networks to prevent:
- Cross-network confusion (testnet vs mainnet)
- Accidental payments to wrong network
- Network-specific parameter validation

### Network Validation
- Applications MUST validate the network parameter against their configured network
- Applications MUST reject payment links for mismatched networks
- Applications MUST warn users before proceeding with network mismatches in development mode

## SEP Compatibility

### SEP-31 (Cross-Border Payments)
When `sep=sep-31` is specified:
- Payment link represents a SEP-31 compliant payment request
- `callback` parameter becomes required
- `amount` parameter becomes required
- Additional SEP-31 fields may be added in future versions

### SEP-38 (Anchor Exchange)
When `sep=sep-38` is specified:
- Payment link represents an exchange request
- `asset` and `issuer` parameters become required
- `amount` parameter becomes required
- Additional SEP-38 fields may be added in future versions

## Security Considerations

### Meta-address Validation
- MUST be exactly 66 characters (0x + 64 hex chars)
- MUST be valid hexadecimal
- SHOULD be validated against known stealth meta-address format

### Parameter Validation
- Amounts MUST be positive decimal numbers
- Asset codes MUST be valid Stellar asset codes (1-12 alphanumeric characters)
- Issuer addresses MUST be valid Stellar public keys
- Callback URLs MUST be valid HTTPS URLs
- Expiration timestamps MUST be valid ISO 8601 format

### URL Encoding
- All parameter values MUST be URL-encoded
- Special characters in memo, label, and callback MUST be properly encoded

## Implementation Requirements

### Encoding
1. Construct URI components in order: version, network, meta-address
2. Append query parameters if present
3. URL-encode all parameter values
4. Validate all components before encoding

### Decoding
1. Parse URI components
2. Validate version (must be supported)
3. Validate network (must match configured network or warn)
4. Validate meta-address format
5. Parse and validate query parameters
6. Return structured payment request object

### Error Handling
- Invalid format: Return descriptive error
- Unsupported version: Return error with supported versions
- Network mismatch: Return error with configured network
- Invalid parameters: Return specific parameter validation errors

## Migration from Legacy Format

### Legacy Format
```
https://example.com/pay/{meta-address}
```

### Migration Path
1. Applications SHOULD support both formats during transition period
2. Legacy format assumes current configured network
3. Legacy format has no versioning
4. Legacy format has no parameter support
5. Applications SHOULD encourage users to upgrade to opaque:// format

## Reference Implementation

See `frontend/src/lib/paymentLink.ts` for TypeScript implementation.
