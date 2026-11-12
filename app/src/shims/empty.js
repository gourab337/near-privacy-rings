// Node's crypto module is not available in browsers. Libraries that check for it (the TDX quote
// verifier, @phala/dcap-qvl) then use their pure-JavaScript code paths.
export default {};