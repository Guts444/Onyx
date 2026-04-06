## 2024-05-18 - Insecure Randomness for ID Generation
**Vulnerability:** Weak, predictable random number generation (`Math.random()`) used for sensitive identifiers.
**Learning:** `Math.random()` does not produce cryptographically secure random numbers and can lead to identifier collisions or predictability, which might be exploitable in certain contexts.
**Prevention:** Always use `crypto.randomUUID()` or `crypto.getRandomValues()` for generating unique identifiers and tokens in JavaScript/TypeScript environments where security is a concern.
