import { getSystemResources, type ResourceMetric } from "@qvac/sdk";

async function main() {
  const { capabilities, sample } = await getSystemResources({ sample: true });

  function printMetric<T>(label: string, metric: ResourceMetric<T>, format: (value: T) => string) {
    if (metric.status === "supported") {
      console.log(`▸ ${label}: ${format(metric.value)}`);
    } else {
      console.log(`▸ ${label}: ${metric.status}`);
    }
  }

  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

  if (capabilities.cpu.status === "supported") {
    printMetric("Logical cores", capabilities.cpu.value.logicalCores, String);
  }

  printMetric("Total memory", capabilities.memory.totalBytes, gib);

  if (sample) {
    printMetric("Memory in use", sample.memory.usedBytes, gib);
  }
}

main().catch(console.error);
