import "dotenv/config";
import { shutdownDatabase } from "./index";
import { seedStaff } from "./seed";

try {
  seedStaff();
  shutdownDatabase();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  shutdownDatabase();
  process.exit(1);
}
