# NEAR Privacy Rings: one entry point for building and testing.
export PATH := $(HOME)/.cargo/bin:$(PATH)

.PHONY: install wasm test test-contract test-sandbox test-sdk test-agent typecheck circuits e2e-testnet

install:            ## JS dependencies
	npm ci --silent
	cd sdk && npm ci --silent
	cd circuits && npm ci --silent
	cd agent && npm ci --silent

wasm:               ## contract wasm -> contract/target/near/near_privacy_rings.wasm
	cd contract && cargo near build non-reproducible-wasm

test: test-sdk test-agent test-contract test-sandbox   ## everything that needs no network

test-sdk:
	cd sdk && npm test

test-agent:         ## agent payment tools against an in-memory pool, real proofs
	cd agent && npm test

typecheck:          ## TypeScript checks for the SDK, agent, relayer, scripts and app (needs app deps: cd app && npm ci)
	npm run typecheck

test-contract:      ## unit tests: real Groth16 proofs verified with alt_bn128 host functions
	cd contract && cargo test --lib

test-sandbox: wasm  ## real wasm on a local NEAR sandbox, prints gas
	cd contract && cargo test --test sandbox -- --nocapture

circuits:           ## recompile the circuit and check committed keys match it
	./scripts/build-circuits.sh

e2e-testnet:        ## full demo on testnet (see README for env vars)
	node scripts/e2e.ts
