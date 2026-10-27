// owner: T2
import type { Workbooks } from "~/server/datasource/types";
import { readBase, readInputs } from "./read";

export { readBase, readInputs };
export const workbooks: Workbooks = { readBase, readInputs };
