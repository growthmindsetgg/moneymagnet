import { resolveEvmChain } from "@/lib/resolveChain";
for (const a of process.argv.slice(2)) console.log(a, JSON.stringify(await resolveEvmChain(a.toLowerCase(), { cache: false })));
