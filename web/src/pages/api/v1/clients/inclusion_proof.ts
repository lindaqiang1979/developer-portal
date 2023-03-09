import { gql } from "@apollo/client";
import {
  errorNotAllowed,
  errorRequiredAttribute,
  errorValidation,
} from "src/backend/errors";
import { getAPIServiceClient } from "src/backend/graphql";
import {
  PHONE_GROUP_ID,
  PHONE_SEQUENCER,
  PHONE_SEQUENCER_STAGING,
} from "src/lib/constants";
import { NextApiRequest, NextApiResponse } from "next";

const existsQuery = gql`
  query IdentityCommitmentExists($identity_commitment: String!) {
    revocation(where: { identity_commitment: { _eq: $identity_commitment } }) {
      identity_commitment
    }
  }
`;

interface ISimplifiedError {
  code: string;
  detail: string;
}

const EXPECTED_ERRORS: Record<string, ISimplifiedError> = {
  "provided identity commitment is invalid": {
    code: "invalid_identity",
    detail: "This identity is not verified for the relevant credential.",
  },
};

/**
 * Checks if the given identity commitment is in the revocation table, and if false,
 * queries an inclusion proof from the relevant signup sequencer
 * @param req
 * @param res
 */
export default async function handleInclusionProof(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!req.method || !["POST", "OPTIONS"].includes(req.method)) {
    return errorNotAllowed(req.method, res);
  }

  for (const attr of ["credential_type", "identity_commitment", "env"]) {
    if (!req.body[attr]) {
      return errorRequiredAttribute(attr, res);
    }
  }

  // TODO: Type environments
  if (!["staging", "production"].includes(req.body.env)) {
    return errorValidation(
      "invalid",
      "Invalid environment value. `staging` or `production` expected.",
      "env",
      res
    );
  }

  // TODO: Only phone credential supported for now
  if (req.body.credential_type !== "phone") {
    return errorValidation(
      "invalid",
      "Invalid credential type. Only `phone` is supported for now.",
      "credential_type",
      res
    );
  }

  const client = await getAPIServiceClient();

  // ANCHOR: Check if the identity commitment has been revoked
  const identityCommitmentExistsResponse = await client.query({
    query: existsQuery,
    variables: { identity_commitment: req.body.identity_commitment },
  });

  // Commitment is in the revocation table, deny the proof request
  console.info(
    `Declined inclusion proof request for revoked commitment: ${req.body.identity_commitment}`
  );

  if (identityCommitmentExistsResponse.data.revocation.length) {
    return errorValidation(
      "unverified_identity",
      "This identity is not verified for the phone credential.",
      "identity_commitment",
      res
    );
  }

  // Commitment is not in the revoke table, so query sequencer for inclusion proof
  const headers = new Headers();
  headers.append(
    "Authorization",
    req.body.env === "production"
      ? `Bearer ${process.env.PHONE_SEQUENCER_KEY}`
      : `Bearer ${process.env.PHONE_SEQUENCER_STAGING_KEY}`
  );
  headers.append("Content-Type", "application/json");
  const body = JSON.stringify([PHONE_GROUP_ID, req.body.identity_commitment]);

  const response = await fetch(
    req.body.env === "production"
      ? `${PHONE_SEQUENCER}/inclusionProof`
      : `${PHONE_SEQUENCER_STAGING}/inclusionProof`,
    {
      method: "POST",
      headers,
      body,
    }
  );

  if (response.status === 200) {
    res.status(200).json({
      inclusion_proof: await response.json(),
    });
  } else if (response.status === 202) {
    res.status(400).json({
      code: "inclusion_pending",
      detail:
        "This identity is in progress of being included on-chain. Please wait a few minutes and try again.",
    });
  } else if (response.status === 400) {
    const error = await response.text();
    if (Object.keys(EXPECTED_ERRORS).includes(error)) {
      return res.status(400).json(EXPECTED_ERRORS[error]);
    } else {
      console.error(
        "Unexpected error (400) fetching proof from phone sequencer",
        await response.text()
      );
      res.status(400).json({
        code: "server_error",
        detail:
          "Unable to get proof for this identity. Please try again later.",
      });
    }
  } else {
    console.error(
      `Unexpected error (${response.status}) fetching proof from phone sequencer`,
      await response.text()
    );
    res.status(503).json({
      code: "server_error",
      detail: "Something went wrong. Please try again.",
    });
  }
}