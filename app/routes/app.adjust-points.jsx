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
  Badge,
  Box,
  InlineStack,
  Select,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  await authenticate.admin(request);
  return Response.json({});
}

export async function action({ request }) {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "search") {
    const query = String(formData.get("query") || "").trim();

    if (!query) {
      return Response.json({ intent: "search", results: [] });
    }

    const results = await prisma.loyaltyMember.findMany({
      where: {
        OR: [
          { email: { contains: query } },
          { firstName: { contains: query } },
          { shopifyCustomerId: { contains: query } },
        ],
      },
      take: 10,
    });

    return Response.json({ intent: "search", results });
  }

  if (intent === "adjust") {
    const shopifyCustomerId = String(formData.get("shopifyCustomerId"));
    const direction = String(formData.get("direction")); // "add" | "remove"
    const amount = parseInt(String(formData.get("amount")), 10);
    const reason = String(formData.get("reason") || "").trim();

    if (!shopifyCustomerId || !amount || amount <= 0 || !reason) {
      return Response.json(
        { intent: "adjust", error: "Please fill in a valid amount and reason." },
        { status: 400 }
      );
    }

    const delta = direction === "remove" ? -amount : amount;

    const [updatedMember] = await prisma.$transaction([
      prisma.loyaltyMember.update({
        where: { shopifyCustomerId },
        data: { points: { increment: delta } },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          shopifyCustomerId,
          description: `${direction === "remove" ? "Removed" : "Added"} by staff: ${reason}`,
          points: delta,
        },
      }),
    ]);

    return Response.json({ intent: "adjust", success: true, updatedMember });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export default function AdjustPoints() {
  useLoaderData();
  const searchFetcher = useFetcher();
  const adjustFetcher = useFetcher();

  const [query, setQuery] = useState("");
  const [selectedMember, setSelectedMember] = useState(null);
  const [direction, setDirection] = useState("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const searchResults = searchFetcher.data?.results || [];
  const isSearching = searchFetcher.state !== "idle";
  const isAdjusting = adjustFetcher.state !== "idle";
  const adjustResult = adjustFetcher.data;

  function handleSearch(value) {
    setQuery(value);
    setSelectedMember(null);
    if (value.trim().length >= 2) {
      const fd = new FormData();
      fd.append("intent", "search");
      fd.append("query", value);
      searchFetcher.submit(fd, { method: "post" });
    }
  }

  function handleSelectMember(member) {
    setSelectedMember(member);
    setQuery(member.email || member.firstName || member.shopifyCustomerId);
  }

  function handleSubmitAdjustment() {
    if (!selectedMember || !amount || !reason.trim()) return;

    const fd = new FormData();
    fd.append("intent", "adjust");
    fd.append("shopifyCustomerId", selectedMember.shopifyCustomerId);
    fd.append("direction", direction);
    fd.append("amount", amount);
    fd.append("reason", reason);
    adjustFetcher.submit(fd, { method: "post" });
  }

  const canSubmit = selectedMember && amount && parseInt(amount, 10) > 0 && reason.trim().length > 0;

  return (
    <Page title="Adjust Points" backAction={{ url: "/app" }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Find a customer</Text>

              <TextField
                label="Search by name, email, or customer ID"
                labelHidden
                placeholder="Search by name, email, or customer ID"
                value={query}
                onChange={handleSearch}
                autoComplete="off"
                loading={isSearching}
              />

              {query.trim().length >= 2 && !selectedMember && (
                <BlockStack gap="200">
                  {searchResults.length > 0 ? (
                    searchResults.map((m) => (
                      <Box
                        key={m.id}
                        padding="300"
                        borderWidth="025"
                        borderColor="border"
                        borderRadius="200"
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="050">
                            <Text as="p" fontWeight="semibold">
                              {m.firstName || "—"} · {m.email || "no email"}
                            </Text>
                            <Text as="p" tone="subdued" variant="bodySm">
                              {m.points} points · {m.tier}
                            </Text>
                          </BlockStack>
                          <Button onClick={() => handleSelectMember(m)}>Select</Button>
                        </InlineStack>
                      </Box>
                    ))
                  ) : (
                    !isSearching && (
                      <Text as="p" tone="subdued">No customers found.</Text>
                    )
                  )}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {selectedMember && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd">
                      {selectedMember.firstName || "Customer"}
                    </Text>
                    <Text as="p" tone="subdued">{selectedMember.email}</Text>
                  </BlockStack>
                  <Badge>{selectedMember.tier}</Badge>
                </InlineStack>

                <Text as="p" variant="bodyMd">
                  Current balance: <strong>{selectedMember.points} points</strong>
                </Text>

                <Select
                  label="Action"
                  options={[
                    { label: "Add points", value: "add" },
                    { label: "Remove points", value: "remove" },
                  ]}
                  value={direction}
                  onChange={setDirection}
                />

                <TextField
                  label="Amount"
                  type="number"
                  value={amount}
                  onChange={setAmount}
                  autoComplete="off"
                  min={1}
                />

                <TextField
                  label="Reason"
                  placeholder="e.g. Customer service goodwill, order return, promo bonus"
                  value={reason}
                  onChange={setReason}
                  autoComplete="off"
                  multiline={2}
                />

                {adjustResult?.error && (
                  <Banner tone="critical">{adjustResult.error}</Banner>
                )}

                {adjustResult?.success && (
                  <Banner tone="success">
                    Updated! New balance: {adjustResult.updatedMember.points} points
                  </Banner>
                )}

                <Button
                  variant="primary"
                  disabled={!canSubmit}
                  loading={isAdjusting}
                  onClick={handleSubmitAdjustment}
                >
                  Confirm {direction === "remove" ? "Removal" : "Addition"}
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}