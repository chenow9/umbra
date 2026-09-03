export function downloadRecoveryCodes(codes: string[]) {
  const blob = new Blob([`Umbra 控制台恢复码\n\n${codes.join("\n")}\n`], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "umbra-recovery-codes.txt";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}
