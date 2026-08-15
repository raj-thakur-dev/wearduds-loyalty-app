import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Button,
  Banner,
  InlineGrid,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Single-row settings table keyed by a fixed id, so there's always exactly one config record
const SETTINGS_ID = "loyalty_settings";

async function getOrCreateSettings() {
  let settings = await prisma.loyaltySettings.findUnique({
    where: { id: SETTINGS_ID },
  });

  if (!settings) {
    settings = await prisma.loyaltySettings.create({
      data: {
        id: SETTINGS_ID,
        pointsPerRupee: 0.01, // 1 point per ₹100
        silverThreshold: 500,
        goldThreshold: 1500,
        redeem500Value: 50,
        redeem1000Value: 120,
        redeem2000Value: 300,
      },
    });
  }

  return settings;
}

export async function loader({ request }) {
  await authenticate.admin(request);
  const settings = await getOrCreateSettings();
  return Response.json({ settings });
}

export async function action({ request }) {
  await authenticate.admin(request);

  const formData = await request.formData();

  const pointsPerRupee = parseFloat(formData.get("pointsPerRupee"));
  const silverThreshold = parseInt(formData.get("silverThreshold"), 10);
  const goldThreshold = parseInt(formData.get("goldThreshold"), 10);
  const redeem500Value = parseInt(formData.get("redeem500Value"), 10);
  const redeem1000Value = parseInt(formData.get("redeem1000Value"), 10);
  const redeem2000Value = parseInt(formData.get("redeem2000Value"), 10);

  if (
    isNaN(pointsPerRupee) ||
    isNaN(silverThreshold) ||
    isNaN(goldThreshold) ||
    isNaN(redeem500Value) ||
    isNaN(redeem1000Value) ||
    isNaN(redeem2000Value)
  ) {
    return Response.json({ error: "All fields must be valid numbers." }, { status: 400 });
  }

  if (goldThreshold <= silverThreshold) {
    return Response.json(
      { error: "Gold threshold must be higher than Silver threshold." },
      { status: 400 }
    );
  }

  const settings = await prisma.loyaltySettings.upsert({
    where: { id: SETTINGS_ID },
    update: {
      pointsPerRupee,
      silverThreshold,
      goldThreshold,
      redeem500Value,
      redeem1000Value,
      redeem2000Value,
    },
    create: {
      id: SETTINGS_ID,
      pointsPerRupee,
      silverThreshold,
      goldThreshold,
      redeem500Value,
      redeem1000Value,
      redeem2000Value,
    },
  });

  return Response.json({ success: true, settings });
}

export default function Settings() {
  const { settings } = useLoaderData();
  const fetcher = useFetcher();

  const [form, setForm] = useState({
    pointsPerRupee: String(settings.pointsPerRupee),
    silverThreshold: String(settings.silverThreshold),
    goldThreshold: String(settings.goldThreshold),
    redeem500Value: String(settings.redeem500Value),
    redeem1000Value: String(settings.redeem1000Value),
    redeem2000Value: String(settings.redeem2000Value),
  });

  const isSaving = fetcher.state !== "idle";
  const result = fetcher.data;

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSave() {
    const fd = new FormData();
    Object.entries(form).forEach(([key, value]) => fd.append(key, value));
    fetcher.submit(fd, { method: "post" });
  }

  return (
    <Page title="Loyalty Settings" backAction={{ url: "/app" }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Point Rate</Text>
              <TextField
                label="Points earned per ₹1 spent"
                type="number"
                step={0.001}
                value={form.pointsPerRupee}
                onChange={(v) => update("pointsPerRupee", v)}
                autoComplete="off"
                helpText="e.g. 0.01 means 1 point per ₹100 spent"
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Tier Thresholds</Text>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <TextField
                  label="Silver tier starts at (points)"
                  type="number"
                  value={form.silverThreshold}
                  onChange={(v) => update("silverThreshold", v)}
                  autoComplete="off"
                />
                <TextField
                  label="Gold tier starts at (points)"
                  type="number"
                  value={form.goldThreshold}
                  onChange={(v) => update("goldThreshold", v)}
                  autoComplete="off"
                />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Redemption Values</Text>
              <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                <TextField
                  label="500 points = ₹"
                  type="number"
                  value={form.redeem500Value}
                  onChange={(v) => update("redeem500Value", v)}
                  autoComplete="off"
                />
                <TextField
                  label="1000 points = ₹"
                  type="number"
                  value={form.redeem1000Value}
                  onChange={(v) => update("redeem1000Value", v)}
                  autoComplete="off"
                />
                <TextField
                  label="2000 points = ₹"
                  type="number"
                  value={form.redeem2000Value}
                  onChange={(v) => update("redeem2000Value", v)}
                  autoComplete="off"
                />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          {result?.error && <Banner tone="critical">{result.error}</Banner>}
          {result?.success && <Banner tone="success">Settings saved.</Banner>}
          <Box paddingBlockStart="200">
            <Button variant="primary" loading={isSaving} onClick={handleSave}>
              Save Settings
            </Button>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}