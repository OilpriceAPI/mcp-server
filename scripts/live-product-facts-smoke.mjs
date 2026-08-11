#!/usr/bin/env node

import { ProductFactsProvider } from "../build/productFacts.js";

const attempts = 3;
let lastResult;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const provider = new ProductFactsProvider({ timeoutMs: 5_000 });
  lastResult = await provider.get();

  if (lastResult.delivery.source === "canonical") {
    const { facts, delivery } = lastResult;
    if (
      facts.offer.freeRequestLimit !== 50 ||
      facts.offer.freeRequestWindow !== "day" ||
      "freeRequestsPerMonth" in facts.offer
    ) {
      throw new Error(
        "canonical product facts did not normalize to the reviewed 50/day contract",
      );
    }

    const sourceMajor = Number(delivery.sourceSchemaVersion.split(".")[0]);
    const expectedNormalization =
      sourceMajor === 1 ? "reviewed-v1-daily-bridge" : "native-v2";
    if (
      ![1, 2].includes(sourceMajor) ||
      delivery.normalization !== expectedNormalization ||
      !delivery.upstreamAvailable ||
      delivery.stale
    ) {
      throw new Error(
        "canonical product-facts source metadata was incompatible or stale",
      );
    }

    process.stdout.write(
      `live product-facts smoke passed: source ${delivery.sourceSchemaVersion}, ${delivery.normalization}, 50/day\n`,
    );
    process.exit(0);
  }

  if (attempt < attempts) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
}

throw new Error(
  `canonical product-facts endpoint was unavailable after ${attempts} attempts: ${lastResult?.delivery.warning ?? "unknown failure"}`,
);
