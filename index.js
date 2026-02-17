const express = require("express");
const cors = require("cors");
require("dotenv").config();
const PORT = process.env.PORT || 5000;
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
//name: parcel-me
// password: WnE3LWtqgYVRF0lg
// middlewares
app.use(cors());
app.use(express.json());
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// for firebase jwt token
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

// mongodb database

const uri = `mongodb+srv://${process.env.USER_NAME}:${process.env.PASSWORD}@cluster0.qhxuye0.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function run() {
  try {
    const myDB = client.db("parcel-me");
    // all collection
    const parcelsCollection = myDB.collection("parcels");
    const paymentCollection = myDB.collection("payments");
    const trackingCollection = myDB.collection("tracking");
    const usersCollection = myDB.collection("user");
    const ridersCollection = myDB.collection("riders");
    const withdrawCollection = myDB.collection("transactions");

    // jwt token verify

    const verifyFirebaseToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized" });
      }

      const token = authHeader.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        res.status(403).send({ message: "Forbidden Access" });
      }
    };

    // verfiy Admin
    const verfiyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user?.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    // verfiy rider
    const verfiyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user?.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    app.post("/parcels", async (req, res) => {
      try {
        const parcelData = req.body;

        const result = await parcelsCollection.insertOne(parcelData);

        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // get data from parcelsCollection by email, payment status and delivery status
    app.get("/parcels", verifyFirebaseToken, async (req, res) => {
      const { email, paymentStatus, deliveryStatus } = req.query;

      const query = {};

      if (email) {
        query.created_by = email;
      }

      if (paymentStatus) {
        query.paymentStatus = paymentStatus;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const parcels = await parcelsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(parcels);
    });

    // get data for specific id
    app.get("/parcels/:parcelId", async (req, res) => {
      try {
        const parcelId = req.params.parcelId;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send("Invalid ID");
        }

        const result = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        res.send(result);
      } catch (err) {
        res.status(500).send(err.message);
      }
    });

    // Assign Rider API where parcelsCollection and rider collection are change their status
    app.patch(
      "/parcels/assign-rider/:parcelId",
      verifyFirebaseToken,
      verfiyAdmin,
      async (req, res) => {
        const parcelId = req.params.parcelId;
        const { riderId, riderEmail } = req.body;

        const session = client.startSession();

        try {
          await session.withTransaction(async () => {
            // update parcel
            await parcelsCollection.updateOne(
              { _id: new ObjectId(parcelId) },
              {
                $set: {
                  deliveryStatus: "rider_assign",
                  assignedRiderId: riderId,
                  assignedRiderEmail: riderEmail,
                  assignedAt: new Date().toISOString(),
                },
              },
              { session },
            );

            // update rider
            await ridersCollection.updateOne(
              { _id: new ObjectId(riderId) },
              {
                $set: {
                  work_status: "in-delivery",
                },
              },
              { session },
            );
          });

          res.send({ success: true });
        } catch (err) {
          res.status(500).send({ message: "Assign failed" });
        } finally {
          await session.endSession();
        }
      },
    );

    // status update when rider receive and delivery parcel and rider earning set also here
    app.patch(
      "/parcels/rider-status/:id",
      verifyFirebaseToken,
      async (req, res) => {
        const id = req.params.id;
        const { status } = req.body;

        // 🆕 FETCH PARCEL (REQUIRED FOR EARNING CALCULATION)
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        const updateDoc = {
          $set: {
            deliveryStatus: status,
          },
        };

        /* ---------------- PICKUP TIME ---------------- */
        if (status === "in-transit") {
          updateDoc.$set.pickedAt = new Date().toISOString();
        }

        /* ---------------- DELIVERY + EARNING ---------------- */
        if (status === "completed") {
          updateDoc.$set.deliveredAt = new Date().toISOString();

          // 🆕 SAME / DIFFERENT DISTRICT CHECK
          const sameDistrict =
            parcel.senderDistrict === parcel.receiverDistrict;

          // 🆕 EARNING LOGIC
          const earnPercentage = sameDistrict ? 0.8 : 0.3;
          const riderEarn = Math.round(parcel.totalCost * earnPercentage);

          // 🆕 SAVE EARNING
          updateDoc.$set.rider_earn = riderEarn;
        }

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc,
        );

        res.send(result);
      },
    );

    // delete parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const result = await parcelsCollection.deleteOne(filter);

        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({
          message: "Failed to delete parcel",
          error: error.message,
        });
      }
    });

    // Create Payment Intent API

    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amountInCent } = req.body;
        console.log("amount", amountInCent);

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCent,
          currency: "USD",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // payment data
    app.post("/payments", async (req, res) => {
      const paymentData = req.body;
      const paymentdoc = {
        ...paymentData,
        paid_at_string: new Date().toISOString(),
        paid_at: new Date(),
      };

      // update parcel payment status
      await parcelsCollection.updateOne(
        { _id: new ObjectId(paymentData.parcelId) },
        {
          $set: {
            paymentStatus: "paid",
          },
        },
      );
      // save payment history
      const paymentResult = await paymentCollection.insertOne(paymentdoc);

      res.send({ success: true, paymentResult });
    });

    // POST – add tracking update
    app.post("/tracking/update", verifyFirebaseToken, async (req, res) => {
      try {
        const { trackingId, status, details, updated_by } = req.body;
        if (!trackingId || !status) {
          return res.status(400).send({
            message: "trackingId and status are required",
          });
        }

        // ✅ INSERT TRACKING RECORD
        const result = await trackingCollection.insertOne({
          trackingId,
          status,
          details,
          updated_by,
          time: new Date(),
        });

        res.send(result);
      } catch (err) {
        res.status(500).send({
          message: "Tracking update failed",
        });
      }
    });

    app.get("/tracking/:trackingId", async (req, res) => {
      const { trackingId } = req.params;

      const records = await trackingCollection
        .find({ trackingId })
        .sort({ createdAt: 1 }) // oldest → newest
        .toArray();

      if (!records.length) {
        return res.status(404).send({ message: "No tracking found" });
      }

      res.send(records);
    });

    // get payment history
    app.get("/payments", verifyFirebaseToken, async (req, res) => {
      const userEmail = req.query.email;
      if (req.decoded.email !== userEmail) {
        return res.status(403).send({ message: "forbiden Access" });
      }

      try {
        const query = userEmail ? { email: userEmail } : {};
        const history = await paymentCollection
          .find(query)
          .sort({ paid_at: -1 }) // Latest first
          .toArray();

        res.send(history);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ message: "Failed to load payment history" });
      }
    });

    // user data get only admin

    app.get("/users", verifyFirebaseToken, verfiyAdmin, async (req, res) => {
      const search = req.query.search || "";

      const query = search
        ? {
            $or: [
              { name: { $regex: search, $options: "i" } },
              { email: { $regex: search, $options: "i" } },
            ],
          }
        : {};

      const users = await usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(users);
    });

    // user insert here
    app.post("/users", async (req, res) => {
      const { name, email, role, createdAt, lastLoginAt } = req.body;

      try {
        // 🔍 check if user exists
        const existingUser = await usersCollection.findOne({ email });

        if (existingUser) {
          // ✅ update last login time
          await usersCollection.updateOne(
            { email },
            {
              $set: {
                lastLoginAt: new Date().toISOString(),
              },
            },
          );

          return res.send({
            isNewUser: false,
            user: existingUser,
          });
        }

        // 🆕 create new user
        const newUser = {
          name,
          email,
          role,
          createdAt,
          lastLoginAt,
        };

        const result = await usersCollection.insertOne(newUser);

        res.send(result);
      } catch (error) {
        res.status(500).send({
          message: "User processing failed",
          error: error.message,
        });
      }
    });

    // change role by admin
    app.patch("/users/:id/role", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;

      if (!role) {
        return res.status(400).send({ message: "Role is required" });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } },
      );

      res.send(result);
    });

    // rider data for fetch
    app.get("/riders", verifyFirebaseToken, verfiyAdmin, async (req, res) => {
      const { status, search } = req.query;

      const query = status ? { status } : {};
      if (search) {
        query.name = { $regex: search, $options: "i" };
      }

      const riders = await ridersCollection
        .find(query)
        .sort({ created_at: -1 })
        .toArray();

      res.send(riders);
    });

    // Get Active Riders by District
    app.get(
      "/riders/active-by-district",
      verifyFirebaseToken,
      verfiyAdmin,
      async (req, res) => {
        const { district } = req.query;

        if (!district) {
          return res.status(400).send({ message: "District required" });
        }

        const riders = await ridersCollection
          .find({
            status: "active",
            district: district,
          })
          .toArray();

        res.send(riders);
      },
    );

    // rider pending deliveries for pending delivery
    app.get(
      "/rider/pending-deliveries",
      verifyFirebaseToken,
      verfiyRider,
      async (req, res) => {
        const email = req.decoded.email;

        const parcels = await parcelsCollection
          .find({
            assignedRiderEmail: email,
            deliveryStatus: { $in: ["in-transit", "rider_assign"] },
          })
          .toArray();

        res.send(parcels);
      },
    );

    // GET rider completed deliveries
    app.get(
      "/rider/completed-deliveries",
      verifyFirebaseToken,
      verfiyRider,
      async (req, res) => {
        const email = req.decoded.email;

        const parcels = await parcelsCollection
          .find({
            assignedRiderEmail: email,
            deliveryStatus: "completed",
          })
          .sort({ deliveredAt: -1 })
          .toArray();

        res.send(parcels);
      },
    );
    //cashout data store here
    app.post(
      "/rider/cashout",
      verifyFirebaseToken,

      async (req, res) => {
        const { amount } = req.body;

        const result = await withdrawCollection.insertOne({
          riderEmail: req.decoded.email,
          amount,
          createdAt: new Date().toISOString(),
        });

        res.send(result);
      },
    );
    // get cash out data
    app.get(
      "/rider/withdraw-total",
      verifyFirebaseToken,
      verfiyRider,
      async (req, res) => {
        const email = req.decoded.email;

        const data = await withdrawCollection
          .aggregate([
            { $match: { riderEmail: email } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ])
          .toArray();

        res.send({ total: data[0]?.total || 0 });
      },
    );

    // GET user role for cusmtom hook so that can understand that is it admin or user or rider
    app.get("/users/role/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1 } },
        );

        if (!user) {
          return res.status(404).send({ role: "user" });
        }

        res.send({ role: user.role });
      } catch (error) {
        res.status(500).send({ message: "Failed to get role" });
      }
    });

    // PATCH /riders/:id/status

    app.patch("/riders/:id/status", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      try {
        // update rider status
        const riderResult = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } },
        );

        // if approved → update user role
        if (status === "active") {
          const rider = await ridersCollection.findOne({
            _id: new ObjectId(id),
          });

          if (rider?.email) {
            await usersCollection.updateOne(
              { email: rider.email },
              { $set: { role: "rider" } },
            );
          }
        }

        // if rejected/deactivated → reset role back to user (optional)
        if (status === "rejected" || status === "deactivated") {
          const rider = await ridersCollection.findOne({
            _id: new ObjectId(id),
          });

          if (rider?.email) {
            await usersCollection.updateOne(
              { email: rider.email },
              { $set: { role: "user" } },
            );
          }
        }

        res.send({
          modifiedCount: riderResult.modifiedCount,
        });
      } catch (err) {
        res.status(500).send({ message: "Status update failed" });
      }
    });

    // rider data for storage
    app.post("/riders", async (req, res) => {
      try {
        const rider = req.body;

        // prevent duplicate application by email
        // const existing = await ridersCollection.findOne({
        //   email: rider.email,
        // });

        // if (existing) {
        //   return res.status(409).send({
        //     message: "You already applied",
        //   });
        // }

        const result = await ridersCollection.insertOne(rider);

        res.send({
          success: true,
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Rider insert error:", error);
        res.status(500).send({
          message: "Failed to save rider",
        });
      }
    });

    // Admin dashboard data

    app.get(
      "/dashboard/admin-stats",
      verifyFirebaseToken,
      verfiyAdmin,
      async (req, res) => {
        try {
          // ================= PARCEL STATS =================
          const parcelStats = await parcelsCollection
            .aggregate([
              {
                $facet: {
                  parcelCounts: [
                    {
                      $group: {
                        _id: null,

                        total: { $sum: 1 },

                        paid: {
                          $sum: {
                            $cond: [{ $eq: ["$paymentStatus", "paid"] }, 1, 0],
                          },
                        },

                        unpaid: {
                          $sum: {
                            $cond: [{ $ne: ["$paymentStatus", "paid"] }, 1, 0],
                          },
                        },

                        // total customer paid
                        totalRevenue: {
                          $sum: {
                            $cond: [
                              { $eq: ["$paymentStatus", "paid"] },
                              "$totalCost",
                              0,
                            ],
                          },
                        },

                        // total rider earning
                        totalRiderEarn: {
                          $sum: {
                            $cond: [
                              { $eq: ["$deliveryStatus", "completed"] },
                              "$rider_earn",
                              0,
                            ],
                          },
                        },

                        // platform profit = totalCost - rider_earn
                        platformRevenue: {
                          $sum: {
                            $cond: [
                              {
                                $and: [
                                  { $eq: ["$paymentStatus", "paid"] },
                                  { $eq: ["$deliveryStatus", "completed"] },
                                ],
                              },
                              { $subtract: ["$totalCost", "$rider_earn"] },
                              0,
                            ],
                          },
                        },
                      },
                    },
                  ],

                  deliveryStatusCounts: [
                    {
                      $group: {
                        _id: "$deliveryStatus",
                        count: { $sum: 1 },
                      },
                    },
                  ],
                },
              },
            ])
            .toArray();

          // ================= USER ROLE STATS =================
          const userRoleStats = await usersCollection
            .aggregate([
              {
                $group: {
                  _id: "$role",
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray();

          const roles = {};
          userRoleStats.forEach((r) => {
            roles[r._id] = r.count;
          });

          // ================= RIDER STATUS STATS =================
          const riderStats = await ridersCollection
            .aggregate([
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray();

          // ================= FORMAT DATA =================
          const parcel = parcelStats[0]?.parcelCounts[0] || {
            total: 0,
            paid: 0,
            unpaid: 0,
            totalRevenue: 0,
            totalRiderEarn: 0,
            platformRevenue: 0,
          };

          const delivery = {};
          parcelStats[0]?.deliveryStatusCounts.forEach((d) => {
            delivery[d._id] = d.count;
          });

          const riders = {};
          riderStats.forEach((r) => {
            riders[r._id] = r.count;
          });

          // ================= FINAL RESPONSE =================
          res.send({
            parcelCounts: {
              total: parcel.total,
              paid: parcel.paid,
              unpaid: parcel.unpaid,
              totalRevenue: parcel.totalRevenue,
              totalRiderEarn: parcel.totalRiderEarn,
              platformRevenue: parcel.platformRevenue,
            },

            deliveryStatusCounts: {
              rider_assign: delivery["rider_assign"] || 0,
              in_transit: delivery["in-transit"] || 0,
              completed: delivery["completed"] || 0,
              not_collected: delivery["not-collected"] || 0,
            },

            riderCounts: {
              active: riders.active || 0,
              rejected: riders.rejected || 0,
              deactivated: riders.deactivated || 0,
            },

            userRoleCounts: {
              user: roles.user || 0,
              rider: roles.rider || 0,
              admin: roles.admin || 0,
            },
          });
        } catch (err) {
          res.status(500).send({
            message: "Dashboard stats failed",
            error: err.message,
          });
        }
      },
    );

    // for rider dashboard
    app.get(
      "/dashboard/rider-stats",
      verifyFirebaseToken,
      verfiyRider,
      async (req, res) => {
        try {
          const email = req.query.email;

          if (!email) {
            return res.status(400).send({ message: "Rider email required" });
          }

          const stats = await parcelsCollection
            .aggregate([
              {
                $match: { assignedRiderEmail: email },
              },
              {
                $facet: {
                  // -------- DELIVERY STATUS --------
                  deliveryStatus: [
                    {
                      $group: {
                        _id: "$deliveryStatus",
                        count: { $sum: 1 },
                      },
                    },
                  ],

                  // -------- TOTAL EARNED --------
                  totalEarned: [
                    {
                      $group: {
                        _id: null,
                        total: { $sum: "$rider_earn" },
                      },
                    },
                  ],
                },
              },
            ])
            .toArray();

          const delivery = {};
          stats[0].deliveryStatus.forEach((d) => {
            delivery[d._id] = d.count;
          });

          res.send({
            deliveryStatusCounts: {
              rider_assign: delivery.rider_assign || 0,
              completed: delivery.completed || 0,
            },
            totalEarned: stats[0].totalEarned[0]?.total || 0,
          });
        } catch (err) {
          res.status(500).send({
            message: "Rider stats failed",
            error: err.message,
          });
        }
      },
    );

    // test route
    app.get("/", (req, res) => {
      res.send("Parcel Delivery Backend Running");
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
  }
}
run().catch(console.dir);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
