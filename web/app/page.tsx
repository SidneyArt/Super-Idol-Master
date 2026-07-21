import Studio from "./Studio";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const taskParam = params.task;
  const initialRunId = Array.isArray(taskParam) ? taskParam[0] : taskParam;

  return <Studio initialRunId={initialRunId || null} />;
}
