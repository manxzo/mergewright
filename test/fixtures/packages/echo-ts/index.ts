interface Host { project: { name: string } }

export function activate(host: Host): { recall: (query: string) => Promise<string[]> } {
  const name: string = host.project.name;
  return { recall: async (query: string) => [`typed recall in ${name} for ${query}`] };
}
