import businessJson from "../../config/business.json";
import { BusinessConfigSchema, type BusinessConfig } from "~/lib/contracts";

export function loadBusinessConfig(): BusinessConfig {
  return BusinessConfigSchema.parse(businessJson);
}
