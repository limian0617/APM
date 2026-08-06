import { db } from "@/lib/db";

export async function readProjectProcurementSettings(projectId: string) {
  return db.projectProcurementSettings.findUnique({ where: { projectId } });
}

export async function readProjectMaterialReference(projectId: string, materialReferenceId: string) {
  return db.materialReference.findFirst({ where: { id: materialReferenceId, projectId } });
}

export async function readProjectSupplierReference(projectId: string, supplierReferenceId: string) {
  return db.supplierReference.findFirst({ where: { id: supplierReferenceId, projectId } });
}
