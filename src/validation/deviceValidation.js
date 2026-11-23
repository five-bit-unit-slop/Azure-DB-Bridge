// Gateway token validation.
//
// The gateway credential is the SHA-256 hash of the gateway token, sent as 64
// lowercase hex characters. The raw token never leaves the gateway.

const TOKEN_HASH_LENGTH = 64;
const TOKEN_HASH_PATTERN = /^[0-9a-f]+$/;

function isValidTokenHash(tokenHash) {
    return typeof tokenHash === 'string'
        && tokenHash.length === TOKEN_HASH_LENGTH
        && TOKEN_HASH_PATTERN.test(tokenHash);
}

module.exports = {
    TOKEN_HASH_LENGTH,
    isValidTokenHash
};
