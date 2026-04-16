import { LaunchGradientBody } from "../../components/launch/launch-gradient-body";

export default function PredictionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LaunchGradientBody />
      {children}
    </>
  );
}
