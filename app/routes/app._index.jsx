import { useState, useMemo } from "react";
import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineGrid,
  Text,
  TextField,
  ButtonGroup,
  Button,
  DataTable,
  Badge,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  await authenticate.admin(request);

  const members = await prisma.loyaltyMember.findMany({
    orderBy: { points: "desc" },
  });

  const redeemedCodes = await prisma.redeemedCode.findMany();

  const totalMembers = members.length;
  const pointsOutstanding = members.reduce((sum, m) => sum + m.points, 0);

  // Sum up ₹ value of all redeemed codes (parses "₹50" -> 50)
  const totalRewardsGiven = redeemedCodes.reduce((sum, c) => {
    const amount = parseInt(String(c.discountValue).replace(/[^0-9]/g, ""), 10) || 0;
    return sum + amount;
  }, 0);

  const activeCodes = redeemedCodes.filter((c) => !c.used).length;

  return Response.json({
    members: members.map((m) => ({
      id: m.id,
      name: [m.firstName].filter(Boolean).join(" ") || "—",
      email: m.email || "—",
      tier: m.tier,
      points: m.points,
      shopifyCustomerId: m.shopifyCustomerId,
    })),
    stats: {
      totalMembers,
      pointsOutstanding,
      totalRewardsGiven,
      activeCodes,
    },
  });
}

const TIER_BADGE_TONE = {
  Bronze: undefined, // default
  Silver: "warning",
  Gold: "success",
};

export default function AdminOverview() {
  const { members, stats } = useLoaderData();
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("All");

  const filteredMembers = useMemo(() => {
    return members.filter((m) => {
      const matchesSearch =
        search.trim() === "" ||
        m.name.toLowerCase().includes(search.toLowerCase()) ||
        m.email.toLowerCase().includes(search.toLowerCase());

      const matchesTier = tierFilter === "All" || m.tier === tierFilter;

      return matchesSearch && matchesTier;
    });
  }, [members, search, tierFilter]);

  const rows = filteredMembers.map((m) => [
    m.name,
    m.email,
    <Badge tone={TIER_BADGE_TONE[m.tier]} key={m.id}>{m.tier}</Badge>,
    m.points.toLocaleString(),
  ]);

  return (
    <Page title="WearDuds Loyalty — Overview">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">Total Members</Text>
                <Text as="p" variant="headingLg">{stats.totalMembers.toLocaleString()}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">Points Outstanding</Text>
                <Text as="p" variant="headingLg">{stats.pointsOutstanding.toLocaleString()}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">₹ Discounts Given</Text>
                <Text as="p" variant="headingLg">₹{stats.totalRewardsGiven.toLocaleString()}</Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">Active Codes</Text>
                <Text as="p" variant="headingLg">{stats.activeCodes.toLocaleString()}</Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Members</Text>

              <TextField
                label="Search"
                labelHidden
                placeholder="Search by name or email"
                value={search}
                onChange={setSearch}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setSearch("")}
              />

              <ButtonGroup variant="segmented">
                {["All", "Bronze", "Silver", "Gold"].map((tier) => (
                  <Button
                    key={tier}
                    pressed={tierFilter === tier}
                    onClick={() => setTierFilter(tier)}
                  >
                    {tier}
                  </Button>
                ))}
              </ButtonGroup>

              {rows.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric"]}
                  headings={["Name", "Email", "Tier", "Points Balance"]}
                  rows={rows}
                />
              ) : (
                <Box padding="400">
                  <Text as="p" tone="subdued" alignment="center">
                    No members match your search.
                  </Text>
                </Box>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}